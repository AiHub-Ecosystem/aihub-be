#!/usr/bin/env bash
set -uo pipefail
umask 077

readonly CONTAINER_RUNTIME_ENTRYPOINT='scripts/runtime/runtime-entrypoint.mjs'
readonly CONTAINER_CLI='scripts/cli/cli.mjs'
readonly STATUS_TIMEOUT_SECONDS=30
readonly DOCKER_EXEC_GRACE_SECONDS=15
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly APP_DIR="${APP_DIR:-$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)}"
export APP_DIR
if [[ ${1:-} == avatar-sweep ]]; then
  default_log="$HOME/aihub-avatar-sweep.log"
elif [[ ${1:-} == chart-upload-sweep ]]; then
  default_log="$HOME/aihub-writing-chart-upload-sweep.log"
elif [[ ${1:-} == speaking-upload-sweep ]]; then
  default_log="$HOME/aihub-speaking-upload-sweep.log"
else
  default_log="$HOME/aihub-ops-job.log"
fi
readonly JOB=${1:-}
readonly LOG_FILE=${AIHUB_HOST_JOB_LOG:-$default_log}
readonly METRICS_DIR=${AIHUB_HOST_JOB_METRICS_DIR:-$HOME/.aihub-host-job-metrics}
from=
to=
quota_month=
avatar_dry_run=false
chart_dry_run=false
speaking_dry_run=false
report_window_provided=false
quota_month_provided=false

if (( $# == 3 )) && [[ "$JOB" == quota && "${2:-}" == --month ]]; then
  quota_month=$3
  quota_month_provided=true
elif (( $# == 3 )) && [[ "$JOB" == avatar-sweep && "${2:-}" == --dry-run && "${3:-}" == true ]]; then
  avatar_dry_run=true
elif (( $# == 3 )) && [[ "$JOB" == chart-upload-sweep && "${2:-}" == --dry-run && "${3:-}" == true ]]; then
  chart_dry_run=true
elif (( $# == 3 )) && [[ "$JOB" == speaking-upload-sweep && "${2:-}" == --dry-run && "${3:-}" == true ]]; then
  speaking_dry_run=true
elif (( $# == 5 )) && [[ "$JOB" == report && "${2:-}" == --from && "${4:-}" == --to ]]; then
  from=$3
  to=$5
  report_window_provided=true
elif (( $# != 1 )); then
  printf 'usage: %s quota [--month YYYY-MM]|prune|report [--from UTC --to UTC]|ttl-audit|avatar-sweep [--dry-run true]|chart-upload-sweep [--dry-run true]|speaking-upload-sweep [--dry-run true]\n' "$0" >&2
  exit 2
fi
# max_age_seconds is how long after a success Prometheus waits for the next
# one before it alerts (#291): one cadence plus an hour for daily jobs, and two
# cadences plus 20 minutes for faster ones, so a run skipped while CD holds the
# schedule does not page.
case "$JOB" in
  quota) commands=(quota:reconcile); timeout_seconds=900; max_age_seconds=90000 ;;
  prune) commands=(usage:prune); timeout_seconds=1800; max_age_seconds=90000 ;;
  report) commands=(usage:report); timeout_seconds=180; max_age_seconds=8400 ;;
  ttl-audit) commands=(redis:ttl-audit); timeout_seconds=900; max_age_seconds=90000 ;;
  avatar-sweep) commands=(avatar:sweep); timeout_seconds=1800; max_age_seconds=90000 ;;
  chart-upload-sweep) commands=(writing:chart-upload-sweep); timeout_seconds=1800; max_age_seconds=3000 ;;
  speaking-upload-sweep) commands=(speaking:audio-upload-sweep); timeout_seconds=1800; max_age_seconds=90000 ;;
  *) printf 'usage: %s quota [--month YYYY-MM]|prune|report [--from UTC --to UTC]|ttl-audit|avatar-sweep [--dry-run true]|chart-upload-sweep [--dry-run true]|speaking-upload-sweep [--dry-run true]\n' "$0" >&2; exit 2 ;;
esac

# Only the bare scheduled form reports to Prometheus; a manual rerun of an
# older window or a dry run says nothing about the schedule.
scheduled=false
(( $# == 1 )) && scheduled=true

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

# Writes the last success or failure time for the node-exporter textfile
# collector, which alert.rules.yml reads for a failed or missed run.
# backup-postgres.sh writes the same format. A write that fails is logged; the
# missing success then alerts as a missed run.
record_job_result() {
  local outcome=$1 file tmp
  [[ "$scheduled" == true ]] || return 0
  file="$METRICS_DIR/$JOB-$outcome.prom"
  tmp="$file.tmp"
  if mkdir -p -- "$METRICS_DIR" && chmod 755 "$METRICS_DIR" && {
    printf 'aihub_host_job_last_%s_timestamp_seconds{task="%s"} %s\n' "$outcome" "$JOB" "$(date +%s)"
    if [[ "$outcome" == success ]]; then
      printf 'aihub_host_job_max_age_seconds{task="%s"} %s\n' "$JOB" "$max_age_seconds"
    fi
  } >"$tmp" && chmod 644 "$tmp" && mv -f -- "$tmp" "$file"; then
    return 0
  fi
  rm -f -- "$tmp"
  log_line "$(date -u +%FT%TZ) $JOB metrics_write_failed outcome=$outcome"
}

if ! command -v flock >/dev/null 2>&1; then
  log_line "$(date -u +%FT%TZ) $JOB failed reason=flock_unavailable"
  exit 1
fi
if ! command -v timeout >/dev/null 2>&1; then
  log_line "$(date -u +%FT%TZ) $JOB failed reason=timeout_unavailable"
  exit 1
fi

lock_dir="$HOME/.aihub-host-job-locks"
if ! mkdir -p -- "$lock_dir" || ! chmod 700 "$lock_dir"; then
  log_line "$(date -u +%FT%TZ) $JOB failed reason=lock_directory_unavailable"
  exit 1
fi
if ! exec 9>"$lock_dir/$JOB.lock"; then
  log_line "$(date -u +%FT%TZ) $JOB failed reason=lock_file_unavailable"
  exit 1
fi
if flock -n 9; then
  :
else
  lock_status=$?
  if [[ "$lock_status" == 1 ]]; then
    log_line "$(date -u +%FT%TZ) $JOB skipped reason=already_running"
    exit 0
  fi
  log_line "$(date -u +%FT%TZ) $JOB failed reason=job_lock_error exit=$lock_status"
  exit 1
fi
if ! exec 8>"$lock_dir/host-jobs.lock"; then
  log_line "$(date -u +%FT%TZ) $JOB failed reason=host_lock_unavailable"
  exit 1
fi
if flock -n 8; then
  :
else
  lock_status=$?
  if [[ "$lock_status" == 1 ]]; then
    log_line "$(date -u +%FT%TZ) $JOB deferred reason=host_job_active"
  else
    log_line "$(date -u +%FT%TZ) $JOB failed reason=host_lock_error exit=$lock_status"
  fi
  exit 1
fi

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

if deployment_status="$(timeout --signal=TERM --kill-after=5s "${STATUS_TIMEOUT_SECONDS}s" \
  "$APP_DIR/scripts/ops/blue-green/blue-green-host.sh" status 2>"$tmp_dir/status.err")"; then
  :
else
  code=$?
  if [[ "$code" == 124 || "$code" == 137 ]]; then
    printf 'deployment status lookup exceeded its %ss deadline\n' \
      "$STATUS_TIMEOUT_SECONDS" >"$tmp_dir/status.err"
  fi
  log_stderr_tail "$(date -u +%FT%TZ)" deployment unresolved "$code" "$tmp_dir/status.err"
  record_job_result failure
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

if [[ "$JOB" == report && "$report_window_provided" == false ]]; then
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
    if [[ "$command" == quota:reconcile && "$quota_month_provided" == true ]]; then
      args+=(--month "$quota_month")
    fi
    if [[ "$command" == usage:report ]]; then
      args+=(--from "$from" --to "$to")
    fi
    if [[ "$command" == avatar:sweep && "$avatar_dry_run" == true ]]; then
      args+=(--dry-run true)
    fi
    if [[ "$command" == writing:chart-upload-sweep && "$chart_dry_run" == true ]]; then
      args+=(--dry-run true)
    fi
    if [[ "$command" == speaking:audio-upload-sweep && "$speaking_dry_run" == true ]]; then
      args+=(--dry-run true)
    fi
    stdout_file="$tmp_dir/stdout"
    stderr_file="$tmp_dir/stderr"
    if timeout --signal=TERM --kill-after=5s "$((timeout_seconds + DOCKER_EXEC_GRACE_SECONDS))s" \
      "${compose[@]}" exec -T "$service" node "$CONTAINER_RUNTIME_ENTRYPOINT" \
      --timeout-seconds "$timeout_seconds" "$CONTAINER_CLI" "${args[@]}" \
      </dev/null >"$stdout_file" 2>"$stderr_file"; then
      summary="$(tail -n 1 "$stdout_file" | tr -d '\r')"
      [[ -n "$summary" ]] || summary='no output'
      log_line "$(date -u +%FT%TZ) $JOB $tier service=$service exit=0 $summary"
    else
      code=$?
      status=1
      if [[ "$code" == 124 || "$code" == 137 ]] &&
        ! grep -Fq 'scheduled command timed out after' "$stderr_file"; then
        printf 'scheduled command exceeded its %ss deadline or Docker exec grace\n' \
          "$timeout_seconds" >>"$stderr_file"
      fi
      log_stderr_tail "$(date -u +%FT%TZ)" "$tier" "$service" "$code" "$stderr_file"
    fi
  done
done

if [[ "$status" == 0 ]]; then
  record_job_result success
else
  record_job_result failure
fi
exit "$status"
