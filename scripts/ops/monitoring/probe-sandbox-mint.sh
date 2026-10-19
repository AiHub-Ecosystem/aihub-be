#!/usr/bin/env bash
# Authenticated Sandbox probe (#291), run every minute from the monitoring
# host's crontab. `/health` proves only that a process answers; minting a
# Sandbox assertion also looks up the API key, takes a Redis rate-limit slot,
# and reads the Organization's identity configuration from Postgres. It calls
# no AI service, consumes no quota, and writes only the key's throttled
# `last_used_at`.
#
# The key belongs to an internal key in the Sandbox allowlist Organization and
# lives in a mode-0600 file outside the repository. It travels to curl through
# a file descriptor, never on the command line.
#
# The result is written in the scheduled-job format of host-scheduled-job.sh
# under the task name sandbox-mint-probe, so the same alert rules fire on a
# failed probe and on a probe that stopped running.
set -uo pipefail
umask 077

readonly URL=${AIHUB_SANDBOX_PROBE_URL:-https://sandbox.aihubproduction.com}/v1/sandbox/assertions
readonly KEY_FILE=${AIHUB_SANDBOX_PROBE_KEY_FILE:-$HOME/aihub-monitoring/secrets/sandbox-probe-api-key}
readonly METRICS_DIR=${AIHUB_HOST_JOB_METRICS_DIR:-$HOME/aihub-monitoring/host-job-metrics}
readonly LOG_FILE=${AIHUB_SANDBOX_PROBE_LOG:-$HOME/aihub-sandbox-probe.log}
readonly TASK=sandbox-mint-probe
# Five missed minutes: cron itself stopped, or the monitoring host is down.
readonly MAX_AGE_SECONDS=300
readonly RETRY_DELAY_SECONDS=${AIHUB_SANDBOX_PROBE_RETRY_DELAY:-5}

record_result() {
  local outcome=$1 file="$METRICS_DIR/$TASK-$1.prom" tmp
  tmp="$file.tmp"
  if mkdir -p -- "$METRICS_DIR" && chmod 755 "$METRICS_DIR" && {
    printf 'aihub_host_job_last_%s_timestamp_seconds{task="%s"} %s\n' "$outcome" "$TASK" "$(date +%s)"
    if [[ "$outcome" == success ]]; then
      printf 'aihub_host_job_max_age_seconds{task="%s"} %s\n' "$TASK" "$MAX_AGE_SECONDS"
    fi
  } >"$tmp" && chmod 644 "$tmp" && mv -f -- "$tmp" "$file"; then
    return 0
  fi
  rm -f -- "$tmp"
  log_line "metrics_write_failed outcome=$outcome"
}

# Only failures are logged, so the file grows with incidents, not with time.
log_line() {
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$TASK" "$1" >>"$LOG_FILE"
}

fail() {
  log_line "failed reason=$1"
  record_result failure
  exit 1
}

[[ -f "$KEY_FILE" ]] || fail key_missing
[[ "$(stat -c %a "$KEY_FILE")" == 600 ]] || fail key_not_mode_600
key="$(tr -d '[:space:]' <"$KEY_FILE")"
[[ "$key" == aihub_sandbox_* ]] || fail key_not_sandbox

body_file="$(mktemp)" || fail tmp_file
trap 'rm -f -- "$body_file"' EXIT

# One retry, so a single dropped connection does not page.
for attempt in 1 2; do
  code="$(curl -sS -o "$body_file" -w '%{http_code}' --max-time 10 -X POST "$URL" \
    -H 'Content-Type: application/json' -H @<(printf 'X-API-Key: %s\n' "$key") \
    -d '{"user_id":"uptime-probe"}' 2>/dev/null)" || code=000
  if [[ "$code" == 200 ]] && grep -q '"assertion":"' "$body_file"; then
    record_result success
    exit 0
  fi
  (( attempt == 1 )) && sleep "$RETRY_DELAY_SECONDS"
done

# The error code is a fixed enum from the API's error envelope; the body is
# never logged whole, since a success body holds an assertion.
error_code="$(grep -o '"code":"[A-Z_]*"' "$body_file" | head -n 1 | cut -d'"' -f4)"
fail "http_${code} error=${error_code:-none}"
