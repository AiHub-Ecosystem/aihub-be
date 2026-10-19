#!/usr/bin/env bash
# Exercises scripts/ops/host-jobs/container-watchdog.sh with stubbed sudo,
# docker, journalctl, and flock: an unhealthy app is restarted and vault-agent is not, the
# restart limit, which Docker events become metrics, the next run's --since,
# a failed events read, old event series being dropped, and the #825
# secret-delivery signals.
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
  exec)
    case "$3" in
      vault) exit "${FAKE_VAULT_STATUS:-0}" ;;
      sh) printf '%s\n' 900 "${FAKE_BUNDLE_MTIME:-1000}" ;;
      *) exit 9 ;;
    esac
    ;;
  logs) cat "$FAKE_AGENT_LOG" 2>/dev/null; true ;;
  inspect) printf '2026-10-19T07:03:16.163648952Z\n' ;;
  *) exit 9 ;;
esac
STUB
cat >"$bin_dir/journalctl" <<'STUB'
#!/usr/bin/env bash
[[ -z "${FAKE_KERNEL_FAIL:-}" ]] && cat "$FAKE_KERNEL"
STUB
chmod 755 "$bin_dir"/*

export PATH="$bin_dir:$PATH" HOME="$home_dir"
export FAKE_DOCKER_CALLS="$test_root/docker-calls" FAKE_PS="$test_root/ps" FAKE_EVENTS="$test_root/events"
export FAKE_KERNEL="$test_root/kernel"
rev=0123456789abcdef0123456789abcdef01234567
sandbox_id=$(printf 'a%.0s' {1..64})

cat >"$FAKE_PS" <<PS
id-app|aihub-production-app-1|app|$rev|Up 3 hours (unhealthy)
$sandbox_id|aihub-production-app-sandbox-1|app-sandbox|$rev|Up 3 hours (healthy)
id-agent|aihub-production-vault-agent-1|vault-agent|$rev|Up 3 days (unhealthy)
id-new|aihub-production-app-slot-b-1|app-slot-b|$rev|Up 1 minute (health: starting)
id-migrate|aihub-production-migrate-1|migrate|$rev|Exited (0) 2 days ago
PS
now=$(date +%s)
# The kernel reports the sandbox OOM kill and one in a container not watched.
other_id=$(printf 'b%.0s' {1..64})
cat >"$FAKE_KERNEL" <<KERNEL
$((now - 40)).123456 host kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=docker-$sandbox_id.scope,mems_allowed=0,oom_memcg=/system.slice/docker-$sandbox_id.scope,task_memcg=/system.slice/docker-$sandbox_id.scope,task=node,pid=7,uid=1000
$((now - 35)).000001 host kernel: Memory cgroup out of memory: Killed process 7 (node)
$((now - 30)).5 host kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=docker-$other_id.scope,mems_allowed=0,oom_memcg=/system.slice/docker-$other_id.scope,task_memcg=/system.slice/docker-$other_id.scope,task=sh,pid=9,uid=0
KERNEL
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
# A die after a stop request, an unwatched service, a healthy transition, and
# Docker's own oom event (the kernel log is the OOM source) are not reported.
assert_not_contains "$prom" 'app-slot-b-1",revision'"=\"$rev\",event"
assert_not_contains "$prom" 'migrate'
assert_lines "$prom" 'event="unhealthy"' 2
assert_lines "$prom" 'event="oom"' 2
assert_not_contains "$prom" 'migrate-1",revision'
assert_contains "$metrics/container-watchdog-success.prom" 'aihub_host_job_max_age_seconds{task="container-watchdog"} 300'
until_first=$(cat "$state/events-until")
if [[ "$(uname -s)" == Linux ]]; then
  [[ "$(stat -c %a "$prom")" == 644 && "$(stat -c %a "$metrics")" == 755 ]] || { echo 'metrics file or directory mode is wrong' >&2; exit 1; }
fi

# Later runs read events from where the last one stopped and keep the counts.
: >"$FAKE_EVENTS"
: >"$FAKE_KERNEL"
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
FAKE_KERNEL_FAIL=1 bash "$script" && { echo 'expected a failed run' >&2; exit 1; }
assert_contains "$log" 'failed reason=kernel_log'
[[ "$(cat "$state/events-until")" == "$before" ]] || { echo 'events-until moved after a failed kernel read' >&2; exit 1; }

# A failed restart fails the run; a series quiet for over seven days is dropped.
rm -f "$state/restarts-aihub-production-app-1"
printf 'old-container|%s|exit|1|4|%s\n' "$rev" "$((now - 700000))" >>"$state/events"
FAKE_RESTART_FAIL=aihub-production-app-1 bash "$script" && { echo 'expected a failed run' >&2; exit 1; }
assert_contains "$log" "restart_failed name=aihub-production-app-1 revision=$rev"
assert_not_contains "$prom" 'old-container'
assert_not_contains "$state/events" 'old-container'

# Secret delivery: healthy by default, then a sealed Vault, an Agent error,
# and a bundle that changed after the apps started.
export FAKE_AGENT_LOG="$test_root/agent-log"
: >"$FAKE_EVENTS"
: >"$FAKE_KERNEL"
bash "$script" || true
assert_contains "$prom" 'aihub_secret_delivery_healthy{reason="ok"} 1'
assert_contains "$prom" 'aihub_runtime_secrets_modified_timestamp_seconds 1000'
assert_contains "$prom" "aihub_runtime_secrets_restart_required{name=\"aihub-production-app-sandbox-1\",revision=\"$rev\"} 0"
assert_not_contains "$prom" 'restart_required{name="aihub-production-vault-agent-1"'
healthy_at=$(cat "$state/secret-delivery-healthy")
# Agent errors are read over the last 10 minutes, not since the last run.
read -r _ _ log_since _ log_until _ < <(grep '^logs ' "$FAKE_DOCKER_CALLS" | tail -n 1)
(( log_until - log_since == 600 )) || { echo "agent log window is $((log_until - log_since)) s" >&2; exit 1; }
assert_contains "$prom" "aihub_secret_delivery_last_healthy_timestamp_seconds $healthy_at"
sleep 1
FAKE_VAULT_STATUS=2 bash "$script" || true
FAKE_VAULT_STATUS=2 bash "$script" || true
assert_contains "$prom" 'aihub_secret_delivery_healthy{reason="vault_sealed"} 0'
assert_contains "$prom" "aihub_secret_delivery_last_healthy_timestamp_seconds $healthy_at"
assert_lines "$log" 'secret_delivery reason=vault_sealed' 1
FAKE_VAULT_STATUS=1 bash "$script" || true
assert_contains "$prom" 'aihub_secret_delivery_healthy{reason="vault_unreachable"} 0'
printf '%s\n' '2026-10-19T03:30:39.413Z [ERROR] agent: (runner) sending server error back to caller' >"$FAKE_AGENT_LOG"
bash "$script" || true
assert_contains "$prom" 'aihub_secret_delivery_healthy{reason="agent_error"} 0'
: >"$FAKE_AGENT_LOG"
FAKE_BUNDLE_MTIME=$(date -d 2026-10-19T08:00:00Z +%s) bash "$script" || true
assert_contains "$prom" 'aihub_secret_delivery_healthy{reason="ok"} 1'
assert_contains "$log" 'secret_delivery reason=ok'
assert_contains "$prom" "aihub_runtime_secrets_restart_required{name=\"aihub-production-app-sandbox-1\",revision=\"$rev\"} 1"
[[ "$(cat "$state/secret-delivery-healthy")" != "$healthy_at" ]] || { echo 'last healthy did not move on recovery' >&2; exit 1; }

printf 'container-watchdog spec passed\n'
