#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
real_flock="$(command -v flock || true)"
real_timeout="$(command -v timeout || true)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

assert_contains() {
  local file=$1 value=$2
  grep -Fq -- "$value" "$file" || {
    printf 'expected %s to contain: %s\n' "$file" "$value" >&2
    exit 1
  }
}

assert_not_contains() {
  local file=$1 value=$2
  if grep -Fq -- "$value" "$file"; then
    printf 'expected %s not to contain: %s\n' "$file" "$value" >&2
    exit 1
  fi
}

# Two jobs that start in the same minute race for the host lock, and the loser
# is deferred rather than retried. This catches a shared start minute only; a
# long job still defers a later one, which the runbook's overlap policy covers.
assert_no_shared_start_minute() {
  awk '
    function expand(field, lo, hi, out,   parts, n, i, p, r, step, a, b, v) {
      n = split(field, parts, ",")
      for (i = 1; i <= n; i++) {
        p = parts[i]; step = 1
        if (index(p, "/")) { split(p, r, "/"); p = r[1]; step = r[2] + 0 }
        if (p == "*") { a = lo; b = hi }
        else if (index(p, "-")) { split(p, r, "-"); a = r[1] + 0; b = r[2] + 0 }
        else { a = p + 0; b = step > 1 ? hi : a }
        for (v = a; v <= b; v += step) out[v] = 1
      }
    }
    /^#/ || NF == 0 { next }
    # The watchdog runs every minute and never takes the host lock.
    /container-watchdog\.sh/ { next }
    {
      if ($3 != "*" || $4 != "*" || $5 != "*") {
        printf "unsupported day field in schedule: %s\n", $0 > "/dev/stderr"
        bad = 1
        next
      }
      split("", minutes); split("", hours)
      expand($1, 0, 59, minutes)
      expand($2, 0, 23, hours)
      for (h in hours) for (m in minutes) {
        key = sprintf("%02d:%02d", h, m)
        if (key in owner) {
          printf "%s and %s both start at %s\n", owner[key], $7, key > "/dev/stderr"
          bad = 1
        } else owner[key] = $7
      }
    }
    END { exit bad }
  ' "$1"
}

assert_no_shared_start_minute "$repository_root/ops/host-jobs/aihub.crontab"
printf '30 2 * * * x prune\n*/15 * * * * x chart-upload-sweep\n' \
  >"$test_root/colliding.crontab"
if assert_no_shared_start_minute "$test_root/colliding.crontab" \
  2>"$test_root/colliding.err"; then
  printf 'expected a shared start minute to be refused\n' >&2
  exit 1
fi
assert_contains "$test_root/colliding.err" 'prune and chart-upload-sweep both start at 02:30'

app_dir="$test_root/app"
bin_dir="$test_root/bin"
home_dir="$test_root/home"
mkdir -p "$app_dir/scripts/ops/host-jobs" "$app_dir/scripts/ops/blue-green" \
  "$app_dir/ops/host-jobs" \
  "$app_dir/.aihub-host-jobs-candidate" "$bin_dir" "$home_dir"
cp "$repository_root/scripts/ops/host-jobs/host-scheduled-job.sh" \
  "$app_dir/.aihub-host-jobs-candidate/host-scheduled-job.sh"
cp "$repository_root/scripts/ops/host-jobs/host-scheduled-job.sh" \
  "$app_dir/scripts/ops/host-jobs/"
cp "$repository_root/scripts/ops/host-jobs/install-host-jobs.sh" \
  "$app_dir/scripts/ops/host-jobs/"
cp "$repository_root/ops/host-jobs/aihub.crontab" \
  "$app_dir/.aihub-host-jobs-candidate/aihub.crontab"
chmod 755 "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" "$app_dir/scripts/ops/host-jobs/install-host-jobs.sh"

cat >"$app_dir/scripts/ops/blue-green/blue-green-host.sh" <<'STUB'
#!/usr/bin/env bash
printf 'production active_slot=b sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa service=app-slot-b\n'
printf 'sandbox active_slot=a sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb service=app-sandbox\n'
STUB
chmod 755 "$app_dir/scripts/ops/blue-green/blue-green-host.sh"

cat >"$bin_dir/sudo" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == -n ]] && shift
exec "$@"
STUB
chmod 755 "$bin_dir/sudo"

cat >"$bin_dir/flock" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == -n && ( "${2:-}" == 9 || "${2:-}" == 8 ) ]] || exit 99
[[ "${FAKE_FLOCK_BUSY:-false}" == true ]] && exit 1
[[ "${1:-}" == -n && "${2:-}" == 8 && "${FAKE_HOST_FLOCK_BUSY:-false}" == true ]] && exit 1
if [[ -n "${REAL_FLOCK:-}" ]]; then
  exec "$REAL_FLOCK" "$@"
fi
exit 0
STUB
chmod 755 "$bin_dir/flock"

cat >"$bin_dir/timeout" <<'STUB'
#!/usr/bin/env bash
args=("$@")
for ((index = 0; index < ${#args[@]}; index += 1)); do
  if [[ "${args[index]}" =~ ^([0-9]+)s$ &&
    "${FAKE_CLAMP_TIMEOUTS:-false}" == true &&
    "${BASH_REMATCH[1]}" -gt 30 ]]; then
    args[index]=0.5s
    break
  fi
done
exec "$REAL_TIMEOUT" "${args[@]}"
STUB
chmod 755 "$bin_dir/timeout"

cat >"$bin_dir/docker" <<'STUB'
#!/usr/bin/env bash
service= timeout_seconds=
while (($#)); do
  if [[ "$1" == exec ]]; then
    shift
    while (($#)); do
      case "$1" in
        -T) shift ;;
        *) break ;;
      esac
    done
    service=${1:-unknown}
    shift
    break
  fi
  shift
done
command_args=("$@")
for ((index = 0; index < ${#command_args[@]}; index += 1)); do
  if [[ "${command_args[index]}" == --timeout-seconds ]]; then
    timeout_seconds=${command_args[index + 1]:-}
    break
  fi
done
printf '%s timeout=%s %s\n' "$service" "$timeout_seconds" "${command_args[*]}" >>"$FAKE_DOCKER_CALLS"
call_count="$(wc -l <"$FAKE_DOCKER_CALLS")"
if [[ "${FAKE_EXPECT_SUSPENDED_CRON:-false}" == true ]] &&
  grep -Eq '^(# BEGIN AIHUB MANAGED JOBS$|.*host-scheduled-job\.sh)' "$FAKE_CRONTAB_FILE"; then
  printf 'managed AIHUB schedule was activated before wrapper smoke\n' >&2
  exit 97
fi
if [[ "${FAKE_DOCKER_BLOCK_SERVICE:-}" == "$service" ]]; then
  : >"$FAKE_DOCKER_BLOCK_STARTED"
  while [[ ! -e "$FAKE_DOCKER_BLOCK_RELEASE" ]]; do sleep 0.05; done
fi
if [[ "${FAKE_DOCKER_HANG_SERVICE:-}" == "$service" ]]; then
  exec sleep 30
fi
if [[ "${FAKE_DOCKER_FAIL_SERVICE:-}" == "$service" ]] ||
  { [[ -n "${FAKE_DOCKER_FAIL_AFTER_CALLS:-}" ]] &&
    ((call_count > FAKE_DOCKER_FAIL_AFTER_CALLS)); }; then
  printf 'partial stdout must not be the failure detail\n'
  for ((i = 1; i <= 60; i += 1)); do printf 'diagnostic-%02d\n' "$i" >&2; done
  exit 7
fi
printf 'intermediate output\nsummary service=%s\n' "$service"
STUB
chmod 755 "$bin_dir/docker"

export PATH="$bin_dir:$PATH"
export HOME="$home_dir"
export AIHUB_HOST_JOB_LOG="$test_root/job.log"
export FAKE_DOCKER_CALLS="$test_root/docker-calls.log"
export REAL_FLOCK="$real_flock"
export REAL_TIMEOUT="$real_timeout"

set +e
FAKE_DOCKER_FAIL_SERVICE=app-slot-b bash \
  "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" quota \
  >"$test_root/run.out" 2>&1
run_status=$?
set -e
[[ "$run_status" == 1 ]]
assert_contains "$FAKE_DOCKER_CALLS" app-slot-b
assert_contains "$FAKE_DOCKER_CALLS" app-sandbox
assert_contains "$AIHUB_HOST_JOB_LOG" 'diagnostic-11'
assert_contains "$AIHUB_HOST_JOB_LOG" 'diagnostic-60'
assert_not_contains "$AIHUB_HOST_JOB_LOG" 'diagnostic-10'
assert_not_contains "$AIHUB_HOST_JOB_LOG" 'partial stdout must not be the failure detail'
assert_not_contains "$AIHUB_HOST_JOB_LOG" 'intermediate output'
assert_contains "$home_dir/.aihub-host-job-metrics/quota-failure.prom" \
  'aihub_host_job_last_failure_timestamp_seconds{task="quota"} '
[[ ! -e "$home_dir/.aihub-host-job-metrics/quota-success.prom" ]]
assert_contains "$AIHUB_HOST_JOB_LOG" 'quota sandbox service=app-sandbox exit=0 summary service=app-sandbox'

: >"$FAKE_DOCKER_CALLS"
: >"$AIHUB_HOST_JOB_LOG"
set +e
FAKE_CLAMP_TIMEOUTS=true FAKE_DOCKER_HANG_SERVICE=app-slot-b bash \
  "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" quota \
  >"$test_root/timeout.out" 2>&1
run_status=$?
set -e
[[ "$run_status" == 1 ]]
assert_contains "$FAKE_DOCKER_CALLS" 'app-slot-b timeout=900'
assert_contains "$FAKE_DOCKER_CALLS" 'app-sandbox timeout=900'
assert_contains "$AIHUB_HOST_JOB_LOG" 'quota production service=app-slot-b exit=124'
assert_contains "$AIHUB_HOST_JOB_LOG" \
  'scheduled command exceeded its 900s deadline or Docker exec grace'
assert_contains "$AIHUB_HOST_JOB_LOG" 'quota sandbox service=app-sandbox exit=0 summary service=app-sandbox'

# A manual rerun of an older window says nothing about the schedule.
rm -f "$home_dir/.aihub-host-job-metrics"/report-*.prom
: >"$FAKE_DOCKER_CALLS"
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" report \
  --from 2026-09-20T12:00:00.000Z --to 2026-09-20T13:00:00.000Z \
  >"$test_root/report.out" 2>&1
assert_contains "$FAKE_DOCKER_CALLS" \
  'usage:report --from 2026-09-20T12:00:00.000Z --to 2026-09-20T13:00:00.000Z'
[[ ! -e "$home_dir/.aihub-host-job-metrics/report-success.prom" ]]

: >"$FAKE_DOCKER_CALLS"
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" quota \
  --month 2026-09 >"$test_root/quota-month.out" 2>&1
assert_contains "$FAKE_DOCKER_CALLS" 'quota:reconcile --month 2026-09'

: >"$FAKE_DOCKER_CALLS"
: >"$AIHUB_HOST_JOB_LOG"
set +e
FAKE_FLOCK_BUSY=true bash "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" quota \
  >"$test_root/overlap.out" 2>&1
run_status=$?
set -e
[[ "$run_status" == 0 ]]
[[ ! -s "$FAKE_DOCKER_CALLS" ]]
assert_contains "$AIHUB_HOST_JOB_LOG" 'quota skipped reason=already_running'
[[ -e "$home_dir/.aihub-host-job-locks/quota.lock" ]]

set +e
FAKE_HOST_FLOCK_BUSY=true bash "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" prune \
  >"$test_root/cross-job-overlap.out" 2>&1
run_status=$?
set -e
[[ "$run_status" == 1 ]]
[[ ! -s "$FAKE_DOCKER_CALLS" ]]
assert_contains "$AIHUB_HOST_JOB_LOG" 'prune deferred reason=host_job_active'
# A deferral is a missed run, not a failure.
[[ ! -e "$home_dir/.aihub-host-job-metrics/prune-failure.prom" ]]

if [[ -n "$REAL_FLOCK" ]]; then
  : >"$FAKE_DOCKER_CALLS"
  : >"$AIHUB_HOST_JOB_LOG"
  block_started="$test_root/block-started"
  block_release="$test_root/block-release"
  FAKE_DOCKER_BLOCK_SERVICE=app-slot-b \
    FAKE_DOCKER_BLOCK_STARTED="$block_started" \
    FAKE_DOCKER_BLOCK_RELEASE="$block_release" \
    APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" quota \
    >"$test_root/first-overlap.out" 2>&1 &
  first_pid=$!
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    [[ -e "$block_started" ]] && break
    sleep 0.05
  done
  [[ -e "$block_started" ]]
  calls_before_second="$(wc -l <"$FAKE_DOCKER_CALLS")"
  APP_DIR="$app_dir" timeout --signal=TERM --kill-after=1s 2s \
    bash "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" quota \
    >"$test_root/second-overlap.out" 2>&1
  [[ "$(wc -l <"$FAKE_DOCKER_CALLS")" == "$calls_before_second" ]]
  assert_contains "$AIHUB_HOST_JOB_LOG" 'quota skipped reason=already_running'

  set +e
  APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" prune \
    >"$test_root/second-cross-job.out" 2>&1
  run_status=$?
  set -e
  [[ "$run_status" == 1 ]]
  [[ "$(wc -l <"$FAKE_DOCKER_CALLS")" == "$calls_before_second" ]]
  assert_contains "$AIHUB_HOST_JOB_LOG" 'prune deferred reason=host_job_active'
  : >"$block_release"
  wait "$first_pid"
fi

for job_and_limits in 'quota 900 90000' 'prune 1800 90000' 'report 180 8400' 'ttl-audit 900 90000' 'avatar-sweep 1800 90000' 'chart-upload-sweep 1800 3000' 'speaking-upload-sweep 1800 90000' 'notification-sweep 900 90000'; do
  read -r job expected_timeout expected_max_age <<<"$job_and_limits"
  : >"$FAKE_DOCKER_CALLS"
  APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" "$job" \
    >"$test_root/$job.out" 2>&1
  assert_contains "$FAKE_DOCKER_CALLS" "app-slot-b timeout=$expected_timeout"
  assert_contains "$FAKE_DOCKER_CALLS" "app-sandbox timeout=$expected_timeout"
  success_file="$home_dir/.aihub-host-job-metrics/$job-success.prom"
  assert_contains "$success_file" "aihub_host_job_last_success_timestamp_seconds{task=\"$job\"} "
  assert_contains "$success_file" "aihub_host_job_max_age_seconds{task=\"$job\"} $expected_max_age"
  [[ "$(stat -c %a "$success_file")" == 644 ]]
done
[[ "$(stat -c %a "$home_dir/.aihub-host-job-metrics")" == 755 ]]
: >"$FAKE_DOCKER_CALLS"
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" avatar-sweep \
  --dry-run true >"$test_root/avatar-dry-run.out" 2>&1
assert_contains "$FAKE_DOCKER_CALLS" 'avatar:sweep --dry-run true'
: >"$FAKE_DOCKER_CALLS"
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" chart-upload-sweep \
  --dry-run true >"$test_root/chart-upload-dry-run.out" 2>&1
assert_contains "$FAKE_DOCKER_CALLS" 'writing:chart-upload-sweep --dry-run true'
: >"$FAKE_DOCKER_CALLS"
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" speaking-upload-sweep \
  --dry-run true >"$test_root/speaking-upload-dry-run.out" 2>&1
assert_contains "$FAKE_DOCKER_CALLS" 'speaking:audio-upload-sweep --dry-run true'

printf 'host wrapper test passed: timeouts, same-job overlap skip, bounded stderr, continued Sandbox run, and job metrics\n'

cat >"$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" <<'STUB'
#!/usr/bin/env bash
printf 'old wrapper must remain active until promotion\n'
STUB
chmod 755 "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh"

cat >"$bin_dir/crontab" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  -l)
    [[ -f "$FAKE_CRONTAB_FILE" ]] || exit 1
    cat "$FAKE_CRONTAB_FILE"
    ;;
  -r) rm -f "$FAKE_CRONTAB_FILE" ;;
  *)
    cp "$1" "$FAKE_CRONTAB_FILE"
    if [[ "${FAKE_CRONTAB_FAIL_ONCE:-false}" == true && ! -e "$FAKE_CRONTAB_FAIL_FILE" ]]; then
      : >"$FAKE_CRONTAB_FAIL_FILE"
      exit 7
    fi
    ;;
esac
STUB
chmod 755 "$bin_dir/crontab"

cat >"$bin_dir/pgrep" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == -f && "${2:-}" == *host-scheduled-job* ]]
printf '%s\n' "$2" >"$FAKE_PGREP_PATTERN_FILE"
remaining="$(cat "$FAKE_PGREP_REMAINING_FILE")"
if ((remaining > 0)); then
  printf '%s\n' "$((remaining - 1))" >"$FAKE_PGREP_REMAINING_FILE"
  exit 0
fi
exit 1
STUB
chmod 755 "$bin_dir/pgrep"

export FAKE_CRONTAB_FILE="$test_root/crontab"
export FAKE_PGREP_REMAINING_FILE="$test_root/pgrep-remaining"
export FAKE_PGREP_PATTERN_FILE="$test_root/pgrep-pattern"
cat >"$FAKE_CRONTAB_FILE" <<'CRON'
0 3 * * * /home/operator/wispace-vault/snapshot.sh
0 2 * * * /home/operator/aihub-ops-job.sh quota
30 3 * * * /home/operator/aihub-avatar-sweep.sh
CRON
cp "$FAKE_CRONTAB_FILE" "$test_root/crontab.before"
cat >"$app_dir/ops/host-jobs/aihub.crontab" <<'CRON'
old template must be restored after failed smoke
CRON

assert_contains "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" 'old wrapper must remain active'
set +e
FAKE_DOCKER_FAIL_SERVICE=app-slot-b APP_DIR="$app_dir" \
  bash "$app_dir/scripts/ops/host-jobs/install-host-jobs.sh" >"$test_root/install-failed.out" 2>&1
install_status=$?
set -e
[[ "$install_status" == 1 ]]
assert_contains "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" 'old wrapper must remain active'
assert_contains "$app_dir/ops/host-jobs/aihub.crontab" 'old template must be restored'
cmp -s "$test_root/crontab.before" "$FAKE_CRONTAB_FILE"
assert_contains "$test_root/install-failed.out" 'candidate scheduled-job smoke failed before wrapper promotion'
assert_not_contains "$test_root/install-failed.out" 'restoring previous state'

docker_call_count="$(wc -l <"$FAKE_DOCKER_CALLS")"
fail_after_calls=$((docker_call_count + 2))
set +e
FAKE_EXPECT_SUSPENDED_CRON=true FAKE_DOCKER_FAIL_AFTER_CALLS="$fail_after_calls" APP_DIR="$app_dir" \
  bash "$app_dir/scripts/ops/host-jobs/install-host-jobs.sh" \
  >"$test_root/install-smoke-failed.out" 2>&1
install_status=$?
set -e
[[ "$install_status" == 1 ]]
assert_contains "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" 'old wrapper must remain active'
assert_contains "$app_dir/ops/host-jobs/aihub.crontab" 'old template must be restored'
cmp -s "$test_root/crontab.before" "$FAKE_CRONTAB_FILE"
assert_contains "$test_root/install-smoke-failed.out" 'installed scheduled-job smoke failed'
assert_contains "$test_root/install-smoke-failed.out" 'scheduled host job activation failed; restoring the suspended state'
assert_not_contains "$test_root/install-smoke-failed.out" 'managed AIHUB schedule was activated before wrapper smoke'

set +e
FAKE_CRONTAB_FAIL_ONCE=true FAKE_CRONTAB_FAIL_FILE="$test_root/crontab-fail-once" \
  APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/install-host-jobs.sh" \
  >"$test_root/install-crontab-failed.out" 2>&1
install_status=$?
set -e
[[ "$install_status" == 7 ]]
assert_contains "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" 'old wrapper must remain active'
assert_contains "$app_dir/ops/host-jobs/aihub.crontab" 'old template must be restored'
cmp -s "$test_root/crontab.before" "$FAKE_CRONTAB_FILE"
assert_contains "$test_root/install-crontab-failed.out" 'scheduled host job activation failed; restoring the suspended state'
assert_not_contains "$test_root/install-crontab-failed.out" 'scheduled host job rollback failed'

FAKE_EXPECT_SUSPENDED_CRON=true APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/install-host-jobs.sh"
assert_contains "$app_dir/scripts/ops/host-jobs/host-scheduled-job.sh" 'CONTAINER_CLI'
assert_contains "$app_dir/ops/host-jobs/aihub.crontab" 'BEGIN AIHUB MANAGED JOBS'
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/install-host-jobs.sh"
assert_contains "$FAKE_CRONTAB_FILE" '/home/operator/wispace-vault/snapshot.sh'
assert_contains "$FAKE_CRONTAB_FILE" "host-scheduled-job.sh' avatar-sweep"
assert_contains "$FAKE_CRONTAB_FILE" "host-scheduled-job.sh' chart-upload-sweep"
assert_contains "$FAKE_CRONTAB_FILE" "host-scheduled-job.sh' speaking-upload-sweep"
assert_contains "$FAKE_CRONTAB_FILE" "host-scheduled-job.sh' notification-sweep"
assert_not_contains "$FAKE_CRONTAB_FILE" 'aihub-ops-job.sh'
assert_not_contains "$FAKE_CRONTAB_FILE" 'aihub-avatar-sweep.sh'
[[ "$(grep -c '^# BEGIN AIHUB MANAGED JOBS$' "$FAKE_CRONTAB_FILE")" == 1 ]]
[[ "$(grep -c 'host-scheduled-job.sh' "$FAKE_CRONTAB_FILE")" == 8 ]]
# A second install keeps one separator line instead of adding another.
[[ "$(grep -c '^$' "$FAKE_CRONTAB_FILE")" == 1 ]]

cp "$FAKE_CRONTAB_FILE" "$test_root/crontab.before-suspend"
printf '1\n' >"$FAKE_PGREP_REMAINING_FILE"
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/install-host-jobs.sh" suspend
assert_contains "$FAKE_CRONTAB_FILE" '/home/operator/wispace-vault/snapshot.sh'
assert_not_contains "$FAKE_CRONTAB_FILE" 'host-scheduled-job.sh'
[[ "$(grep -c '^$' "$FAKE_CRONTAB_FILE")" == 1 ]]
cmp -s "$test_root/crontab.before-suspend" "$app_dir/.aihub-host-jobs-state/crontab"
[[ "$(cat "$FAKE_PGREP_REMAINING_FILE")" == 0 ]]
assert_contains "$FAKE_PGREP_PATTERN_FILE" '(^|/)aihub-ops-job\.sh'
assert_contains "$FAKE_PGREP_PATTERN_FILE" '(^|/)aihub-avatar-sweep\.sh'
assert_contains "$FAKE_PGREP_PATTERN_FILE" \
  '/scripts/ops/host-jobs/host-scheduled-job\.sh'
assert_contains "$FAKE_PGREP_PATTERN_FILE" \
  '/scripts/ops/host-scheduled-job\.sh'
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/install-host-jobs.sh" suspend \
  >"$test_root/suspend-retry.out"
assert_contains "$test_root/suspend-retry.out" 'already suspended and drained'
cmp -s "$test_root/crontab.before-suspend" "$app_dir/.aihub-host-jobs-state/crontab"

printf '0 2 * * * /home/operator/aihub-ops-job.sh quota\n' >"$FAKE_CRONTAB_FILE"
set +e
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/install-host-jobs.sh" suspend \
  >"$test_root/suspend-legacy-retry.out" 2>&1
suspend_status=$?
set -e
[[ "$suspend_status" == 1 ]]
assert_contains "$test_root/suspend-legacy-retry.out" 'managed jobs remain in the crontab'

cat >"$FAKE_CRONTAB_FILE" <<'CRON'
# BEGIN AIHUB MANAGED JOBS
0 3 * * * /tmp/host-scheduled-job.sh quota
# END AIHUB MANAGED JOBS
CRON
set +e
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/install-host-jobs.sh" suspend \
  >"$test_root/suspend-unsafe-retry.out" 2>&1
suspend_status=$?
set -e
[[ "$suspend_status" == 1 ]]
assert_contains "$test_root/suspend-unsafe-retry.out" 'managed jobs remain in the crontab'
assert_contains "$FAKE_CRONTAB_FILE" '# BEGIN AIHUB MANAGED JOBS'
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/host-jobs/install-host-jobs.sh" restore
cmp -s "$test_root/crontab.before-suspend" "$FAKE_CRONTAB_FILE"
[[ ! -e "$app_dir/.aihub-host-jobs-state" ]]

printf 'host installer test passed: smoke rollback, schedule suspend/drain/restore\n'
