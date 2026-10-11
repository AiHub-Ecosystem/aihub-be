#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
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

app_dir="$test_root/app"
bin_dir="$test_root/bin"
home_dir="$test_root/home"
mkdir -p "$app_dir/scripts/ops" "$app_dir/ops/host-jobs" \
  "$app_dir/.aihub-host-jobs-candidate" "$bin_dir" "$home_dir"
cp "$repository_root/scripts/ops/host-scheduled-job.sh" \
  "$app_dir/.aihub-host-jobs-candidate/host-scheduled-job.sh"
cp "$repository_root/scripts/ops/host-scheduled-job.sh" "$app_dir/scripts/ops/"
cp "$repository_root/scripts/ops/install-host-jobs.sh" "$app_dir/scripts/ops/"
cp "$repository_root/ops/host-jobs/aihub.crontab" \
  "$app_dir/.aihub-host-jobs-candidate/aihub.crontab"
chmod 755 "$app_dir/scripts/ops/host-scheduled-job.sh" "$app_dir/scripts/ops/install-host-jobs.sh"

cat >"$app_dir/scripts/ops/blue-green-host.sh" <<'STUB'
#!/usr/bin/env bash
printf 'production active_slot=b sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa service=app-slot-b\n'
printf 'sandbox active_slot=a sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb service=app-sandbox\n'
STUB
chmod 755 "$app_dir/scripts/ops/blue-green-host.sh"

cat >"$bin_dir/sudo" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == -n ]] && shift
exec "$@"
STUB
chmod 755 "$bin_dir/sudo"

cat >"$bin_dir/docker" <<'STUB'
#!/usr/bin/env bash
service=
while (($#)); do
  if [[ "$1" == exec ]]; then
    shift
    [[ "${1:-}" == -T ]] && shift
    service=${1:-unknown}
    break
  fi
  shift
done
printf '%s\n' "$service" >>"$FAKE_DOCKER_CALLS"
call_count="$(wc -l <"$FAKE_DOCKER_CALLS")"
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

set +e
FAKE_DOCKER_FAIL_SERVICE=app-slot-b bash \
  "$app_dir/scripts/ops/host-scheduled-job.sh" quota \
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
assert_contains "$AIHUB_HOST_JOB_LOG" 'quota sandbox service=app-sandbox exit=0 summary service=app-sandbox'

printf 'host wrapper test passed: bounded failure stderr and continued Sandbox run\n'

cat >"$app_dir/scripts/ops/host-scheduled-job.sh" <<'STUB'
#!/usr/bin/env bash
printf 'old wrapper must remain active until promotion\n'
STUB
chmod 755 "$app_dir/scripts/ops/host-scheduled-job.sh"

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
[[ "${1:-}" == -f && "${2:-}" == *host-scheduled-job.sh* ]]
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
cat >"$FAKE_CRONTAB_FILE" <<'CRON'
0 3 * * * /home/ngoc_anh/wispace-vault/snapshot.sh
0 2 * * * /home/ngoc_anh/aihub-ops-job.sh quota
30 3 * * * /home/ngoc_anh/aihub-avatar-sweep.sh
CRON
cp "$FAKE_CRONTAB_FILE" "$test_root/crontab.before"
cat >"$app_dir/ops/host-jobs/aihub.crontab" <<'CRON'
old template must be restored after failed smoke
CRON

assert_contains "$app_dir/scripts/ops/host-scheduled-job.sh" 'old wrapper must remain active'
set +e
FAKE_DOCKER_FAIL_SERVICE=app-slot-b APP_DIR="$app_dir" \
  bash "$app_dir/scripts/ops/install-host-jobs.sh" >"$test_root/install-failed.out" 2>&1
install_status=$?
set -e
[[ "$install_status" == 1 ]]
assert_contains "$app_dir/scripts/ops/host-scheduled-job.sh" 'old wrapper must remain active'
assert_contains "$app_dir/ops/host-jobs/aihub.crontab" 'old template must be restored'
cmp -s "$test_root/crontab.before" "$FAKE_CRONTAB_FILE"
assert_contains "$test_root/install-failed.out" 'candidate scheduled-job smoke failed before wrapper promotion'
assert_not_contains "$test_root/install-failed.out" 'restoring previous state'

docker_call_count="$(wc -l <"$FAKE_DOCKER_CALLS")"
fail_after_calls=$((docker_call_count + 2))
set +e
FAKE_DOCKER_FAIL_AFTER_CALLS="$fail_after_calls" APP_DIR="$app_dir" \
  bash "$app_dir/scripts/ops/install-host-jobs.sh" \
  >"$test_root/install-smoke-failed.out" 2>&1
install_status=$?
set -e
[[ "$install_status" == 1 ]]
assert_contains "$app_dir/scripts/ops/host-scheduled-job.sh" 'old wrapper must remain active'
assert_contains "$app_dir/ops/host-jobs/aihub.crontab" 'old template must be restored'
cmp -s "$test_root/crontab.before" "$FAKE_CRONTAB_FILE"
assert_contains "$test_root/install-smoke-failed.out" 'installed scheduled-job smoke failed'
assert_contains "$test_root/install-smoke-failed.out" 'scheduled host job activation failed; restoring the suspended state'

set +e
FAKE_CRONTAB_FAIL_ONCE=true FAKE_CRONTAB_FAIL_FILE="$test_root/crontab-fail-once" \
  APP_DIR="$app_dir" bash "$app_dir/scripts/ops/install-host-jobs.sh" \
  >"$test_root/install-crontab-failed.out" 2>&1
install_status=$?
set -e
[[ "$install_status" == 7 ]]
assert_contains "$app_dir/scripts/ops/host-scheduled-job.sh" 'old wrapper must remain active'
assert_contains "$app_dir/ops/host-jobs/aihub.crontab" 'old template must be restored'
cmp -s "$test_root/crontab.before" "$FAKE_CRONTAB_FILE"
assert_contains "$test_root/install-crontab-failed.out" 'scheduled host job activation failed; restoring the suspended state'
assert_not_contains "$test_root/install-crontab-failed.out" 'scheduled host job rollback failed'

APP_DIR="$app_dir" bash "$app_dir/scripts/ops/install-host-jobs.sh"
assert_contains "$app_dir/scripts/ops/host-scheduled-job.sh" 'CONTAINER_CLI'
assert_contains "$app_dir/ops/host-jobs/aihub.crontab" 'BEGIN AIHUB MANAGED JOBS'
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/install-host-jobs.sh"
assert_contains "$FAKE_CRONTAB_FILE" '/home/ngoc_anh/wispace-vault/snapshot.sh'
assert_contains "$FAKE_CRONTAB_FILE" "host-scheduled-job.sh' avatar-sweep"
assert_not_contains "$FAKE_CRONTAB_FILE" 'aihub-ops-job.sh'
assert_not_contains "$FAKE_CRONTAB_FILE" 'aihub-avatar-sweep.sh'
[[ "$(grep -c '^# BEGIN AIHUB MANAGED JOBS$' "$FAKE_CRONTAB_FILE")" == 1 ]]
[[ "$(grep -c 'host-scheduled-job.sh' "$FAKE_CRONTAB_FILE")" == 5 ]]

cp "$FAKE_CRONTAB_FILE" "$test_root/crontab.before-suspend"
printf '1\n' >"$FAKE_PGREP_REMAINING_FILE"
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/install-host-jobs.sh" suspend
assert_contains "$FAKE_CRONTAB_FILE" '/home/ngoc_anh/wispace-vault/snapshot.sh'
assert_not_contains "$FAKE_CRONTAB_FILE" 'host-scheduled-job.sh'
cmp -s "$test_root/crontab.before-suspend" "$app_dir/.aihub-host-jobs-state/crontab"
[[ "$(cat "$FAKE_PGREP_REMAINING_FILE")" == 0 ]]
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/install-host-jobs.sh" restore
cmp -s "$test_root/crontab.before-suspend" "$FAKE_CRONTAB_FILE"
[[ ! -e "$app_dir/.aihub-host-jobs-state" ]]

printf 'host installer test passed: smoke rollback, schedule suspend/drain/restore\n'
