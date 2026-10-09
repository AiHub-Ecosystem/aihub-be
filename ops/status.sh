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
# a container is missing, not running, not healthy, failing its /health or
# /ready probe, or on a commit other than the expected one.

set -u

expected="${1:-}"
api_config=/etc/nginx/conf.d/aihub-api.conf
sandbox_config=/etc/nginx/conf.d/sandbox.conf
docker=(sudo -n docker)
status=0

active_port() {
  local config="$1" ports=()
  mapfile -t ports < <(sed -nE 's#^[[:space:]]*proxy_pass http://127\.0\.0\.1:([0-9]+);.*#\1#p' "$config" | sort -u)
  [ "${#ports[@]}" -eq 1 ] || return 1
  printf '%s\n' "${ports[0]}"
}

container_for_port() {
  case "$1:$2" in
    production:3021) printf aihub-production-app-1 ;;
    production:3023) printf aihub-production-app-slot-b-1 ;;
    sandbox:3022) printf aihub-production-app-sandbox-1 ;;
    sandbox:3024) printf aihub-production-app-sandbox-slot-b-1 ;;
    *) return 1 ;;
  esac
}

for label in production sandbox; do
  config="$api_config"
  if [ "$label" = sandbox ]; then
    config="$sandbox_config"
    if [ ! -f "$config" ]; then
      printf '%-10s SKIP disabled\n' "$label"
      continue
    fi
  fi
  if ! port="$(active_port "$config")"; then
    printf '%-10s FAIL cannot read a single active nginx upstream\n' "$label"
    status=1
    continue
  fi
  if ! name="$(container_for_port "$label" "$port")"; then
    printf '%-10s FAIL unsupported nginx upstream port=%s\n' "$label" "$port"
    status=1
    continue
  fi

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

  health_probe=$("${docker[@]}" exec "$name" node -e \
    "fetch('http://127.0.0.1:3000/health').then(r=>console.log(r.status)).catch(()=>console.log('ERR'))" \
    </dev/null 2>&1 | tail -n 1)
  readiness_probe=$("${docker[@]}" exec "$name" node -e \
    "fetch('http://127.0.0.1:3000/ready').then(r=>console.log(r.status)).catch(()=>console.log('ERR'))" \
    </dev/null 2>&1 | tail -n 1)

  verdict=ok
  [ "$state" = running ] || verdict=FAIL
  [ "$health" = healthy ] || verdict=FAIL
  [ "$health_probe" = 200 ] || verdict=FAIL
  [ "$readiness_probe" = 200 ] || verdict=FAIL
  if [ -n "$expected" ] && [ "${revision#"$expected"}" = "$revision" ]; then
    verdict=FAIL
  fi
  [ "$verdict" = ok ] || status=1

  printf '%-10s %-4s revision=%s state=%s health=%s health_probe=%s readiness_probe=%s restarts=%s errors=%s since=%s\n' \
    "$label" "$verdict" "${revision:0:7}" "$state" "$health" "$health_probe" "$readiness_probe" "$restarts" "$errors" "$started"
done

exit "$status"
