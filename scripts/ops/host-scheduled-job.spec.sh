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
mkdir -p "$app_dir/scripts/ops" "$app_dir/ops/host-jobs" "$bin_dir" "$home_dir"
cp "$repository_root/scripts/ops/host-scheduled-job.sh" "$app_dir/scripts/ops/"
cp "$repository_root/scripts/ops/install-host-jobs.sh" "$app_dir/scripts/ops/"
cp "$repository_root/ops/host-jobs/aihub.crontab" "$app_dir/ops/host-jobs/"
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
if [[ "${FAKE_DOCKER_FAIL_SERVICE:-}" == "$service" ]]; then
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
FAKE_DOCKER_FAIL_SERVICE=app-slot-b bash "$app_dir/scripts/ops/host-scheduled-job.sh" quota >"$test_root/run.out" 2>&1
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

cat >"$bin_dir/crontab" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  -l)
    [[ -f "$FAKE_CRONTAB_FILE" ]] || exit 1
    cat "$FAKE_CRONTAB_FILE"
    ;;
  *) cp "$1" "$FAKE_CRONTAB_FILE" ;;
esac
STUB
chmod 755 "$bin_dir/crontab"

export FAKE_CRONTAB_FILE="$test_root/crontab"
cat >"$FAKE_CRONTAB_FILE" <<'CRON'
0 3 * * * /home/ngoc_anh/wispace-vault/snapshot.sh
0 2 * * * /home/ngoc_anh/aihub-ops-job.sh quota
30 3 * * * /home/ngoc_anh/aihub-avatar-sweep.sh
CRON

APP_DIR="$app_dir" bash "$app_dir/scripts/ops/install-host-jobs.sh"
APP_DIR="$app_dir" bash "$app_dir/scripts/ops/install-host-jobs.sh"
assert_contains "$FAKE_CRONTAB_FILE" '/home/ngoc_anh/wispace-vault/snapshot.sh'
assert_contains "$FAKE_CRONTAB_FILE" "host-scheduled-job.sh' avatar-sweep"
assert_not_contains "$FAKE_CRONTAB_FILE" 'aihub-ops-job.sh'
assert_not_contains "$FAKE_CRONTAB_FILE" 'aihub-avatar-sweep.sh'
[[ "$(grep -c '^# BEGIN AIHUB MANAGED JOBS$' "$FAKE_CRONTAB_FILE")" == 1 ]]
[[ "$(grep -c 'host-scheduled-job.sh' "$FAKE_CRONTAB_FILE")" == 5 ]]

printf 'host installer test passed: idempotent managed schedule preserves unrelated cron\n'
