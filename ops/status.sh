#!/usr/bin/env bash
# Read-only report of what is deployed on the production host: for each AIHUB
# container, the commit it runs, its health, restarts, and error-like log lines
# since it started. Changes nothing.
#
# Nothing is installed on the host; the script travels over stdin:
#
#   ssh <user>@<host> 'bash -s -- <expected-commit-sha>' < ops/status.sh
#
# The expected commit is optional. With it, a container on any other commit is a
# failure, which is how "is the latest code live?" gets a yes or no.
#
# Needs `sudo -n docker`, the same access the deploy uses. Exit status is 1 when
# a container is missing, not running, not healthy, failing its own /health
# probe, or on a commit other than the expected one.

set -u

expected="${1:-}"
containers=(
  "production aihub-production-app-1"
  "sandbox aihub-production-app-sandbox-1"
)
docker=(sudo -n docker)
status=0

for entry in "${containers[@]}"; do
  label=${entry%% *}
  name=${entry#* }

  info=$("${docker[@]}" inspect "$name" --format \
    '{{index .Config.Labels "org.opencontainers.image.revision"}} {{.State.Status}} {{.State.Health.Status}} {{.RestartCount}} {{.State.StartedAt}}' \
    </dev/null 2>/dev/null) || {
    printf '%-10s MISSING container %s\n' "$label" "$name"
    status=1
    continue
  }
  read -r revision state health restarts started <<<"$info"

  # Lines since this container started, so an old crash does not count.
  errors=$("${docker[@]}" logs --since "$started" "$name" </dev/null 2>&1 \
    | grep -ciE '"level":"error"|\bERROR\b|\bFATAL\b|unhandled|exception')

  probe=$("${docker[@]}" exec "$name" node -e \
    "fetch('http://127.0.0.1:3000/health').then(r=>console.log(r.status)).catch(()=>console.log('ERR'))" \
    </dev/null 2>&1 | tail -n 1)

  verdict=ok
  [ "$state" = running ] || verdict=FAIL
  [ "$health" = healthy ] || verdict=FAIL
  [ "$probe" = 200 ] || verdict=FAIL
  if [ -n "$expected" ] && [ "${revision#"$expected"}" = "$revision" ]; then
    verdict=FAIL
  fi
  [ "$verdict" = ok ] || status=1

  printf '%-10s %-4s revision=%s state=%s health=%s probe=%s restarts=%s errors=%s since=%s\n' \
    "$label" "$verdict" "${revision:0:7}" "$state" "$health" "$probe" "$restarts" "$errors" "$started"
done

exit "$status"
