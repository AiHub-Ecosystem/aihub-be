#!/usr/bin/env bash
# Verifies public edge health monitoring failure tolerance and duration recording (#710).
# Single or transient probe failures during CPU/IO contention do not roll back a healthy release,
# sustained failure (3 consecutive non-2xx samples) or total outage triggers rollback,
# and per-sample duration is recorded in edge-probes.tsv.
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repository_root"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_equals() {
  [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"
}

extract() {
  awk -v name="$1" '
    $0 == name "() {" { printing = 1 }
    printing { print }
    printing && $0 == "}" { exit }
  ' "$2"
}

for function_name in probe_host failed_edge_tiers probe_window \
  edge_monitor_start edge_monitor_stop final_edge_window; do
  definition="$(extract "$function_name" scripts/ops/blue-green/blue-green-host.sh)"
  [[ -n "$definition" ]] || fail "$function_name is missing from blue-green-host.sh"
  eval "$definition"
done

STATE_DIR="$test_root/state"
mkdir -p "$STATE_DIR"
production_host="api.example.com"
sandbox_host="sandbox.example.com"
sandbox_routed=true
edge_monitor_pid=""
edge_monitor_flag=""
edge_monitor_offset=0
edge_monitor_failures=""
edge_monitor_phase="idle"
EDGE_MONITOR_FAILURE_THRESHOLD=3

log="$STATE_DIR/edge-probes.tsv"

# 1. Verify probe_host appends per-sample duration and phase to edge-probes.tsv
curl() {
  printf '200\t0.042\n'
  return 0
}

probe_host production "$production_host" "candidate-start"
[[ -f "$log" ]] || fail "edge-probes.tsv was not created"

sample="$(tail -n 1 "$log")"
IFS=$'\t' read -r col_start col_end col_tier col_status col_duration col_phase <<<"$sample"
assert_equals "$col_tier" "production" "recorded tier"
assert_equals "$col_status" "200" "recorded status"
assert_equals "$col_duration" "0.042" "recorded duration"
assert_equals "$col_phase" "candidate-start" "recorded phase"

# 2. Verify timeout status recording and fallback duration
curl() {
  printf '000\t4.003\n'
  return 28
}

probe_host sandbox "$sandbox_host" "migration" || true
sample="$(tail -n 1 "$log")"
IFS=$'\t' read -r col_start col_end col_tier col_status col_duration col_phase <<<"$sample"
assert_equals "$col_tier" "sandbox" "recorded timeout tier"
assert_equals "$col_status" "000request_error" "recorded timeout status"
assert_equals "$col_duration" "4.003" "recorded timeout duration"
assert_equals "$col_phase" "migration" "recorded timeout phase"

# 3. Tolerated window: 1 failed sample inside tolerated window does not fail the tier
: > "$log"
curl() {
  printf '200\t0.020\n'
  return 0
}
offset=0
printf '2026-10-16T10:00:00Z\t2026-10-16T10:00:00Z\tproduction\t200\t0.030\tpull\n' >>"$log"
printf '2026-10-16T10:00:01Z\t2026-10-16T10:00:05Z\tproduction\t000request_error\t4.002\tpull\n' >>"$log"
printf '2026-10-16T10:00:02Z\t2026-10-16T10:00:02Z\tproduction\t200\t0.035\tpull\n' >>"$log"
printf '2026-10-16T10:00:00Z\t2026-10-16T10:00:00Z\tsandbox\t200\t0.030\tpull\n' >>"$log"
printf '2026-10-16T10:00:01Z\t2026-10-16T10:00:01Z\tsandbox\t200\t0.032\tpull\n' >>"$log"

failures="$(failed_edge_tiers "$offset")"
assert_equals "$failures" "" "single failed probe does not fail tier"

# 4. Tolerated window: 2 consecutive failed samples (e.g. transient contention during extraction) does not fail
: > "$log"
printf '2026-10-16T10:00:00Z\t2026-10-16T10:00:00Z\tproduction\t200\t0.030\textract\n' >>"$log"
printf '2026-10-16T10:00:01Z\t2026-10-16T10:00:05Z\tproduction\t000request_error\t4.001\textract\n' >>"$log"
printf '2026-10-16T10:00:02Z\t2026-10-16T10:00:06Z\tproduction\t000request_error\t4.002\textract\n' >>"$log"
printf '2026-10-16T10:00:03Z\t2026-10-16T10:00:03Z\tproduction\t200\t0.035\textract\n' >>"$log"
printf '2026-10-16T10:00:00Z\t2026-10-16T10:00:00Z\tsandbox\t200\t0.030\textract\n' >>"$log"
printf '2026-10-16T10:00:01Z\t2026-10-16T10:00:01Z\tsandbox\t200\t0.032\textract\n' >>"$log"

failures="$(failed_edge_tiers "$offset")"
assert_equals "$failures" "" "two consecutive transient failures do not fail tier"

# 5. Sustained failure: 3 consecutive failed samples triggers tier failure
: > "$log"
printf '2026-10-16T10:00:00Z\t2026-10-16T10:00:00Z\tproduction\t200\t0.030\tstart\n' >>"$log"
printf '2026-10-16T10:00:01Z\t2026-10-16T10:00:05Z\tproduction\t000request_error\t4.001\tstart\n' >>"$log"
printf '2026-10-16T10:00:02Z\t2026-10-16T10:00:06Z\tproduction\t000request_error\t4.002\tstart\n' >>"$log"
printf '2026-10-16T10:00:03Z\t2026-10-16T10:00:07Z\tproduction\t000request_error\t4.003\tstart\n' >>"$log"
printf '2026-10-16T10:00:04Z\t2026-10-16T10:00:04Z\tproduction\t200\t0.035\tstart\n' >>"$log"
printf '2026-10-16T10:00:00Z\t2026-10-16T10:00:00Z\tsandbox\t200\t0.030\tstart\n' >>"$log"

failures="$(failed_edge_tiers "$offset")"
assert_equals "$failures" "production" "3 consecutive failures marks production failed"

# 6. Real outage: sustained outage triggers rollback in final_edge_window
: > "$log"
curl() {
  printf '502\t0.010\n'
  return 0
}

rolled_back=()
rollback() {
  rolled_back+=("$1")
  return 0
}

EDGE_MONITOR_FAILURE_THRESHOLD=3
# A 4-second window where all samples fail 502 Bad Gateway
if final_edge_window 4; then
  fail "final_edge_window succeeded despite sustained 502 outage"
fi

[[ "${#rolled_back[@]}" -gt 0 ]] || fail "real outage did not trigger rollback"
assert_equals "${rolled_back[0]}" "production" "outage rolled back failing tier"

# 7. Transient 1-sample failure in final_edge_window succeeds without rollback
: > "$log"
rolled_back=()
sample_count=0
curl() {
  sample_count=$((sample_count + 1))
  if [[ "$sample_count" -eq 2 ]]; then
    printf '000\t4.000\n'
    return 28
  fi
  printf '200\t0.020\n'
  return 0
}

if ! final_edge_window 4; then
  fail "final_edge_window failed on transient 1-sample failure"
fi
assert_equals "${#rolled_back[@]}" "0" "transient failure did not roll back"

# 8. Fallback probe: if an active tier has no samples in the window, probe once
: > "$log"
fallback_log="$test_root/fallback-probes.log"
: > "$fallback_log"
curl() {
  printf '%s\n' "$*" >> "$fallback_log"
  printf '200\t0.020\n'
  return 0
}

# Log has samples for production only
printf '2026-10-16T10:00:00Z\t2026-10-16T10:00:00Z\tproduction\t200\t0.030\twindow\n' >>"$log"
failures="$(failed_edge_tiers 0)"
assert_equals "$failures" "" "healthy production with fallback sandbox"
# Sandbox had no samples, so fallback probed sandbox
grep -q "https://${sandbox_host}/health" "$fallback_log" || fail "sandbox was not fallback-probed"

# 9. edge_monitor_start and edge_monitor_stop lifecycle with transient vs sustained failure
: > "$log"
curl() {
  printf '200\t0.020\n'
  return 0
}
edge_monitor_start 0 "candidate-test"
printf '2026-10-16T10:00:00Z\t2026-10-16T10:00:00Z\tproduction\t200\t0.030\tcandidate-test\n' >>"$log"
printf '2026-10-16T10:00:01Z\t2026-10-16T10:00:05Z\tproduction\t000request_error\t4.001\tcandidate-test\n' >>"$log"
printf '2026-10-16T10:00:02Z\t2026-10-16T10:00:02Z\tproduction\t200\t0.035\tcandidate-test\n' >>"$log"
printf '2026-10-16T10:00:00Z\t2026-10-16T10:00:00Z\tsandbox\t200\t0.030\tcandidate-test\n' >>"$log"
edge_monitor_stop
assert_equals "$edge_monitor_failures" "" "edge_monitor tolerated transient failure during candidate start"

edge_monitor_start 0 "candidate-test"
printf '2026-10-16T10:00:00Z\t2026-10-16T10:00:04Z\tproduction\t000request_error\t4.001\tcandidate-test\n' >>"$log"
printf '2026-10-16T10:00:01Z\t2026-10-16T10:00:05Z\tproduction\t000request_error\t4.002\tcandidate-test\n' >>"$log"
printf '2026-10-16T10:00:02Z\t2026-10-16T10:00:06Z\tproduction\t000request_error\t4.003\tcandidate-test\n' >>"$log"
edge_monitor_stop
assert_equals "$edge_monitor_failures" "production" "edge_monitor reported sustained failure during candidate start"

printf 'blue-green edge monitor spec: PASS\n'
