#!/usr/bin/env bash
set -uo pipefail

# shortcut: jobs have no timeout or overlap lock until #495 is implemented.
readonly CONTAINER_RUNTIME_ENTRYPOINT='scripts/runtime/runtime-entrypoint.mjs'
readonly CONTAINER_CLI='scripts/cli/cli.mjs'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly APP_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
export APP_DIR
if [[ ${1:-} == avatar-sweep ]]; then
  default_log="$HOME/aihub-avatar-sweep.log"
else
  default_log="$HOME/aihub-ops-job.log"
fi
readonly JOB=${1:-}
readonly LOG_FILE=${AIHUB_HOST_JOB_LOG:-$default_log}

if (( $# != 1 )); then
  printf 'usage: %s quota|prune|report|ttl-audit|avatar-sweep\n' "$0" >&2
  exit 2
fi
case "$JOB" in
  quota) commands=(quota:reconcile) ;;
  prune) commands=(usage:prune) ;;
  report) commands=(usage:report) ;;
  ttl-audit) commands=(redis:ttl-audit) ;;
  avatar-sweep) commands=(avatar:sweep) ;;
  *) printf 'usage: %s quota|prune|report|ttl-audit|avatar-sweep\n' "$0" >&2; exit 2 ;;
esac

if ! cd "$APP_DIR"; then
  printf 'cannot enter AIHUB deployment directory: %s\n' "$APP_DIR" >&2
  exit 1
fi
if ! : >>"$LOG_FILE"; then
  printf 'cannot write scheduled-job log: %s\n' "$LOG_FILE" >&2
  exit 1
fi

log_line() {
  printf '%s\n' "$1" | tee -a "$LOG_FILE" || {
    printf 'cannot append scheduled-job log: %s\n' "$LOG_FILE" >&2
    exit 1
  }
}

tmp_dir="$(mktemp -d)" || exit 1
trap 'rm -rf -- "$tmp_dir"' EXIT

log_stderr_tail() {
  local timestamp=$1 tier=$2 service=$3 code=$4 stderr_file=$5 line
  log_line "$timestamp $JOB $tier service=$service exit=$code"
  if [[ -s "$stderr_file" ]]; then
    while IFS= read -r line; do
      log_line "$timestamp $JOB $tier stderr: $line"
    done < <(tail -n 50 "$stderr_file")
  else
    log_line "$timestamp $JOB $tier stderr: (empty)"
  fi
}

if deployment_status="$("$APP_DIR/scripts/ops/blue-green-host.sh" status 2>"$tmp_dir/status.err")"; then
  :
else
  code=$?
  log_stderr_tail "$(date -u +%FT%TZ)" deployment unresolved "$code" "$tmp_dir/status.err"
  exit 1
fi

compose=(sudo -n docker compose --env-file .env.production)
if [[ -f .aihub-deploy.env ]]; then
  compose+=(--env-file .aihub-deploy.env)
fi
compose+=(--profile blue-green --profile sandbox -f docker-compose.production.yml)

active_service() {
  local tier=$1 line slot service
  line="$(awk -v tier="$tier" '
    $1 == tier { count++; record=$0 }
    END { if (count != 1) exit 1; print record }
  ' <<<"$deployment_status")" || {
    printf 'cannot resolve exactly one active %s service\n' "$tier" >&2
    return 1
  }
  slot="${line#*active_slot=}"
  slot="${slot%% *}"
  service="${line##* service=}"
  case "$tier:$slot:$service" in
    production:a:app|production:b:app-slot-b|sandbox:a:app-sandbox|sandbox:b:app-sandbox-slot-b)
      printf '%s\n' "$service"
      ;;
    *)
      printf 'unsupported active %s slot/service in deployment status\n' "$tier" >&2
      return 1
      ;;
  esac
}

from=
to=
if [[ "$JOB" == report ]]; then
  from="$(date -u -d '1 hour ago' +%Y-%m-%dT%H:00:00.000Z)" || exit 1
  to="$(date -u +%Y-%m-%dT%H:00:00.000Z)" || exit 1
fi

status=0
for tier in production sandbox; do
  timestamp="$(date -u +%FT%TZ)"
  if [[ "$tier" == sandbox ]] && grep -Fxq 'sandbox disabled' <<<"$deployment_status"; then
    log_line "$timestamp $JOB sandbox status=disabled skipped"
    continue
  fi

  if service="$(active_service "$tier" 2>"$tmp_dir/resolve.err")"; then
    :
  else
    code=$?
    log_stderr_tail "$timestamp" "$tier" unresolved "$code" "$tmp_dir/resolve.err"
    status=1
    continue
  fi

  for command in "${commands[@]}"; do
    args=("$command")
    if [[ "$command" == usage:report ]]; then
      args+=(--from "$from" --to "$to")
    fi
    stdout_file="$tmp_dir/stdout"
    stderr_file="$tmp_dir/stderr"
    if "${compose[@]}" exec -T "$service" node "$CONTAINER_RUNTIME_ENTRYPOINT" "$CONTAINER_CLI" "${args[@]}" </dev/null >"$stdout_file" 2>"$stderr_file"; then
      summary="$(tail -n 1 "$stdout_file" | tr -d '\r')"
      [[ -n "$summary" ]] || summary='no output'
      log_line "$(date -u +%FT%TZ) $JOB $tier service=$service exit=0 $summary"
    else
      code=$?
      status=1
      log_stderr_tail "$(date -u +%FT%TZ)" "$tier" "$service" "$code" "$stderr_file"
    fi
  done
done

exit "$status"
