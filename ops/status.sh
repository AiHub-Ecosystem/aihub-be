#!/usr/bin/env bash
# Read-only report of what is deployed on the production host: for each AIHUB
# container, the commit it runs, dependency readiness, restarts, and error-like
# log lines since it started. Changes nothing.
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
repository_url=https://github.com/AiHub-Ecosystem/aihub-be
status=0

# nginx reaches a slot through its published port or, once the apps listen on a
# Unix socket, through the socket file named after its Compose service.
active_upstream() {
  local config="$1" upstreams=()
  mapfile -t upstreams < <(sed -nE 's#^[[:space:]]*proxy_pass http://(127\.0\.0\.1:[0-9]+|unix:[^;[:space:]]+);.*#\1#p' "$config" | sort -u)
  [ "${#upstreams[@]}" -eq 1 ] || return 1
  printf '%s\n' "${upstreams[0]}"
}

container_for_upstream() {
  local tier="$1" upstream="$2" service id selected= matches=0 match
  local -a ids=()
  case "$upstream" in
    unix:*)
      service="${upstream##*/}"
      match="label=com.docker.compose.service=${service%.sock}"
      ;;
    *) match="publish=${upstream##*:}" ;;
  esac
  mapfile -t ids < <("${docker[@]}" ps --all --quiet --filter "$match" \
    --filter "label=org.opencontainers.image.source=$repository_url")
  for id in "${ids[@]}"; do
    service="$("${docker[@]}" inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$id" \
      </dev/null 2>/dev/null)" || continue
    case "$tier:$service" in
      production:app | production:app-slot-b | sandbox:app-sandbox | sandbox:app-sandbox-slot-b) ;;
      *) continue ;;
    esac
    selected="$id"
    matches=$((matches + 1))
  done
  [ "$matches" -eq 1 ] || return 1
  printf '%s\n' "$selected"
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
  if ! upstream="$(active_upstream "$config")"; then
    printf '%-10s FAIL cannot read a single active nginx upstream\n' "$label"
    status=1
    continue
  fi
  if ! container="$(container_for_upstream "$label" "$upstream")"; then
    printf '%-10s FAIL no unique AIHUB container for nginx upstream=%s\n' "$label" "$upstream"
    status=1
    continue
  fi

  info=$("${docker[@]}" inspect "$container" --format \
    '{{index .Config.Labels "org.opencontainers.image.revision"}} {{.State.Status}} {{.State.Health.Status}} {{.RestartCount}} {{.State.StartedAt}}' \
    </dev/null 2>/dev/null) || {
    printf '%-10s MISSING container for upstream=%s\n' "$label" "$upstream"
    status=1
    continue
  }
  read -r revision state health restarts started <<<"$info"

  # Lines since this container started, so an old crash does not count.
  errors=$("${docker[@]}" logs --since "$started" "$container" </dev/null 2>&1 \
    | grep -ciE '"level":"error"|\bERROR\b|\bFATAL\b|unhandled|exception')

  health_probe=$("${docker[@]}" exec "$container" node -e \
    "fetch('http://127.0.0.1:3000/health').then(r=>console.log(r.status)).catch(()=>console.log('ERR'))" \
    </dev/null 2>&1 | tail -n 1)
  readiness_result=$("${docker[@]}" exec "$container" node -e '
    const unavailable = (status = "ERR") =>
      console.log(`${status}|unavailable|fail`);

    fetch("http://127.0.0.1:3000/ready", {
      signal: AbortSignal.timeout(2_000),
    }).then(async (response) => {
      let body;
      try {
        body = await response.json();
      } catch {
        unavailable(response.status);
        return;
      }

      const isRecord = typeof body === "object" && body !== null && !Array.isArray(body);
      const dependencies = isRecord ? body.dependencies : null;
      const entries =
        typeof dependencies === "object" && dependencies !== null && !Array.isArray(dependencies)
          ? Object.entries(dependencies)
          : [];
      const valid =
        isRecord &&
        ["ok", "error"].includes(body.status) &&
        entries.length > 0 &&
        // HealthModule always registers these; control-plane probes can be deduplicated by URL.
        ["runtime-postgres", "redis"].every((required) =>
          entries.some(([name]) => name === required)
        ) &&
        entries.every(([name, state]) =>
          /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) && ["up", "down"].includes(state)
        );
      if (!valid) {
        unavailable(response.status);
        return;
      }

      const states = entries.map(([name, state]) => `${name}=${state}`).join(",");
      const healthy =
        response.status === 200 &&
        body.status === "ok" &&
        entries.every(([, state]) => state === "up");
      console.log(`${response.status}|${states}|${healthy ? "ok" : "fail"}`);
    }).catch(() => unavailable());
  ' </dev/null 2>&1 | tail -n 1)
  IFS='|' read -r readiness_probe readiness_dependencies readiness_verdict <<<"$readiness_result"
  if [[ ! "$readiness_probe" =~ ^(ERR|[0-9]{3})$ ||
    ! "$readiness_verdict" =~ ^(ok|fail)$ ||
    ( "$readiness_dependencies" != unavailable &&
      ! "$readiness_dependencies" =~ ^[a-z0-9-]+=(up|down)(,[a-z0-9-]+=(up|down))*$ ) ]]; then
    readiness_probe=ERR
    readiness_dependencies=unavailable
    readiness_verdict=fail
  fi

  verdict=ok
  [ "$state" = running ] || verdict=FAIL
  [ "$health" = healthy ] || verdict=FAIL
  [ "$health_probe" = 200 ] || verdict=FAIL
  [ "$readiness_probe" = 200 ] || verdict=FAIL
  [ "$readiness_verdict" = ok ] || verdict=FAIL
  if [ -n "$expected" ] && [ "${revision#"$expected"}" = "$revision" ]; then
    verdict=FAIL
  fi
  [ "$verdict" = ok ] || status=1

  printf '%-10s %-4s revision=%s state=%s health=%s health_probe=%s readiness_probe=%s readiness_dependencies=%s restarts=%s errors=%s since=%s\n' \
    "$label" "$verdict" "${revision:0:7}" "$state" "$health" "$health_probe" "$readiness_probe" "$readiness_dependencies" "$restarts" "$errors" "$started"
done

exit "$status"
