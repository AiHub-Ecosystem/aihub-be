#!/usr/bin/env bash
# Exercises scripts/ops/host-jobs/container-watchdog.sh with stubbed sudo,
# docker, and flock: an unhealthy app is restarted and vault-agent is not, the
# restart limit, which Docker events become metrics, the next run's --since,
# a failed events read, and old event series being dropped.
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
script="$repository_root/scripts/ops/host-jobs/container-watchdog.sh"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

bin_dir="$test_root/bin"
home_dir="$test_root/home"
metrics="$home_dir/.aihub-host-job-metrics"
state="$home_dir/.aihub-container-watchdog"
log="$home_dir/aihub-container-watchdog.log"
mkdir -p "$bin_dir" "$home_dir"

assert_contains() {
  grep -Fq -- "$2" "$1" || { printf 'expected %s to contain: %s\n' "$1" "$2" >&2; cat "$1" >&2; exit 1; }
}
assert_not_contains() {
  if grep -Fq -- "$2" "$1"; then printf 'expected %s not to contain: %s\n' "$1" "$2" >&2; cat "$1" >&2; exit 1; fi
}
assert_lines() {
  local actual
  actual=$(grep -c -- "$2" "$1" || true)
  [[ "$actual" == "$3" ]] || { printf 'expected %s lines matching %s in %s, got %s\n' "$3" "$2" "$1" "$actual" >&2; exit 1; }
}

cat >"$bin_dir/sudo" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == -n ]] && shift
exec "$@"
STUB
cat >"$bin_dir/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat >"$bin_dir/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_CALLS"
case "$1" in
  ps) cat "$FAKE_PS" ;;
  restart) [[ "${*: -1}" != "${FAKE_RESTART_FAIL:-none}" ]] ;;
  events) [[ -z "${FAKE_EVENTS_FAIL:-}" ]] && cat "$FAKE_EVENTS" ;;
  *) exit 9 ;;
esac
STUB
chmod 755 "$bin_dir"/*

export PATH="$bin_dir:$PATH" HOME="$home_dir"
export FAKE_DOCKER_CALLS="$test_root/docker-calls" FAKE_PS="$test_root/ps" FAKE_EVENTS="$test_root/events"
rev=0123456789abcdef0123456789abcdef01234567

cat >"$FAKE_PS" <<PS
aihub-production-app-1|app|$rev|Up 3 hours (unhealthy)
aihub-production-app-sandbox-1|app-sandbox|$rev|Up 3 hours (healthy)
aihub-production-vault-agent-1|vault-agent|$rev|Up 3 days (unhealthy)
aihub-production-app-slot-b-1|app-slot-b|$rev|Up 1 minute (health: starting)
PS
now=$(date +%s)
cat >"$FAKE_EVENTS" <<EVENTS
health_status: unhealthy|id-app|aihub-production-app-1|app||$rev|$((now - 50))
oom|id-sandbox|aihub-production-app-sandbox-1|app-sandbox||$rev|$((now - 40))
die|id-sandbox|aihub-production-app-sandbox-1|app-sandbox|137|$rev|$((now - 40))
die|id-old|aihub-production-app-slot-b-1|app-slot-b|0|$rev|$((now - 30))
stop|id-old|aihub-production-app-slot-b-1|app-slot-b||$rev|$((now - 30))
die|id-migrate|aihub-production-migrate-1|migrate|1|$rev|$((now - 20))
health_status: healthy|id-app|aihub-production-app-1|app||$rev|$((now - 10))
EVENTS

# First run: the unhealthy app is restarted, vault-agent only reported.
bash "$script"
prom="$metrics/container-watchdog-containers.prom"
assert_lines "$FAKE_DOCKER_CALLS" '^restart ' 1
assert_contains "$FAKE_DOCKER_CALLS" 'restart -t 30 aihub-production-app-1'
assert_contains "$log" "restarted name=aihub-production-app-1 revision=$rev reason=unhealthy"
assert_contains "$prom" "aihub_container_unhealthy{name=\"aihub-production-app-1\",revision=\"$rev\"} 0"
assert_contains "$prom" "aihub_container_unhealthy{name=\"aihub-production-vault-agent-1\",revision=\"$rev\"} 1"
assert_contains "$prom" "aihub_container_unhealthy{name=\"aihub-production-app-sandbox-1\",revision=\"$rev\"} 0"
assert_contains "$prom" "aihub_container_events_total{name=\"aihub-production-app-1\",revision=\"$rev\",event=\"unhealthy\",exit_code=\"\"} 1"
assert_contains "$prom" "aihub_container_events_total{name=\"aihub-production-app-1\",revision=\"$rev\",event=\"watchdog_restart\",exit_code=\"\"} 1"
assert_contains "$prom" "aihub_container_events_total{name=\"aihub-production-app-sandbox-1\",revision=\"$rev\",event=\"oom\",exit_code=\"\"} 1"
assert_contains "$prom" "aihub_container_events_total{name=\"aihub-production-app-sandbox-1\",revision=\"$rev\",event=\"exit\",exit_code=\"137\"} 1"
assert_contains "$prom" "aihub_container_last_event_timestamp_seconds{name=\"aihub-production-app-sandbox-1\",revision=\"$rev\",event=\"oom\",exit_code=\"\"} $((now - 40))"
# A die after a stop request, an unwatched service, and a healthy transition are not reported.
assert_not_contains "$prom" 'app-slot-b-1",revision'"=\"$rev\",event"
assert_not_contains "$prom" 'migrate'
assert_lines "$prom" 'event="unhealthy"' 2
assert_contains "$metrics/container-watchdog-success.prom" 'aihub_host_job_max_age_seconds{task="container-watchdog"} 300'
until_first=$(cat "$state/events-until")
if [[ "$(uname -s)" == Linux ]]; then
  [[ "$(stat -c %a "$prom")" == 644 && "$(stat -c %a "$metrics")" == 755 ]] || { echo 'metrics file or directory mode is wrong' >&2; exit 1; }
fi

# Later runs read events from where the last one stopped and keep the counts.
: >"$FAKE_EVENTS"
bash "$script"
assert_contains "$FAKE_DOCKER_CALLS" "events --since $until_first "
assert_contains "$prom" "aihub_container_events_total{name=\"aihub-production-app-1\",revision=\"$rev\",event=\"watchdog_restart\",exit_code=\"\"} 2"
assert_contains "$prom" "event=\"oom\",exit_code=\"\"} 1"

# Third restart, then the limit: the fourth run leaves it unhealthy.
bash "$script"
bash "$script"
assert_lines "$FAKE_DOCKER_CALLS" '^restart ' 3
assert_contains "$log" 'restart_skipped name=aihub-production-app-1'
assert_contains "$log" 'reason=limit restarts=3 window_seconds=3600'
assert_contains "$prom" "aihub_container_unhealthy{name=\"aihub-production-app-1\",revision=\"$rev\"} 1"
assert_contains "$metrics/container-watchdog-success.prom" 'last_success'
[[ ! -e "$metrics/container-watchdog-failure.prom" ]] || { echo 'unexpected failure file' >&2; exit 1; }

# A failed events read fails the run and does not move --since forward.
before=$(cat "$state/events-until")
sleep 1
FAKE_EVENTS_FAIL=1 bash "$script" && { echo 'expected a failed run' >&2; exit 1; }
assert_contains "$log" 'failed reason=docker_events'
assert_contains "$metrics/container-watchdog-failure.prom" 'aihub_host_job_last_failure_timestamp_seconds{task="container-watchdog"}'
[[ "$(cat "$state/events-until")" == "$before" ]] || { echo 'events-until moved after a failed read' >&2; exit 1; }

# A failed restart fails the run; a series quiet for over seven days is dropped.
rm -f "$state/restarts-aihub-production-app-1"
printf 'old-container|%s|exit|1|4|%s\n' "$rev" "$((now - 700000))" >>"$state/events"
FAKE_RESTART_FAIL=aihub-production-app-1 bash "$script" && { echo 'expected a failed run' >&2; exit 1; }
assert_contains "$log" "restart_failed name=aihub-production-app-1 revision=$rev"
assert_not_contains "$prom" 'old-container'
assert_not_contains "$state/events" 'old-container'

printf 'container-watchdog spec passed\n'
