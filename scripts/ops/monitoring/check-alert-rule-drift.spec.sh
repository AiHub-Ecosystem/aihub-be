#!/usr/bin/env bash
# Exercises scripts/ops/monitoring/check-alert-rule-drift.sh with a stubbed curl:
# matching rules record success; a rules file that differs from the repository,
# a rule the monitoring Prometheus has not loaded, an unreachable repository and
# an unreachable Prometheus each record failure with a short reason.
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
script="$repository_root/scripts/ops/monitoring/check-alert-rule-drift.sh"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

bin_dir="$test_root/bin"
metrics="$test_root/metrics"
mkdir -p "$bin_dir"

assert_contains() {
  grep -Fq -- "$2" "$1" || { printf 'expected %s to contain: %s\n' "$1" "$2" >&2; cat "$1" >&2; exit 1; }
}

# curl ... -o <file> <url>: answers the rules URL with FAKE_REPO_RULES and the
# Prometheus rules API with FAKE_RULES_API; FAKE_REPO_FAIL or FAKE_API_FAIL make
# that request fail the way `curl -f` does.
cat >"$bin_dir/curl" <<'STUB'
#!/usr/bin/env bash
out= url=
while (( $# )); do
  case "$1" in
    -o) out=$2; shift ;;
    --max-time) shift ;;
    http*) url=$1 ;;
  esac
  shift
done
case "$url" in
  *api/v1/rules)
    [[ -n "${FAKE_API_FAIL:-}" ]] && exit 7
    cat "$FAKE_RULES_API" >"$out" ;;
  *)
    [[ -n "${FAKE_REPO_FAIL:-}" ]] && exit 22
    cat "$FAKE_REPO_RULES" >"$out" ;;
esac
STUB
chmod 755 "$bin_dir/curl"

# The monitoring host and CI have python3; a Windows workstation may have it
# only as `python`.
if ! python3 -c '' 2>/dev/null; then
  printf '#!/usr/bin/env bash\nexec python "$@"\n' >"$bin_dir/python3"
  chmod 755 "$bin_dir/python3"
fi

rules() {
  local name
  printf 'groups:\n  - name: test\n    rules:\n'
  for name in "$@"; do
    printf '      - alert: %s\n        expr: up == 0\n        labels:\n          severity: warning\n        annotations:\n          summary: test\n' "$name"
  done
  printf '      - record: aihub:alert_rules_fingerprint\n        expr: vector(1)\n        labels:\n          rules_sha256: "%064d"\n' 0
}

fingerprint_repo() {
  node "$repository_root/scripts/ops/monitoring/update-alert-rules-fingerprint.mjs" --file "$test_root/repo-rules.yml"
}

api() {
  local name first=true fingerprint=${FAKE_LOADED_FINGERPRINT:-}
  if [[ -z "$fingerprint" ]]; then
    fingerprint="$(sed -nE 's/^[[:space:]]*rules_sha256: "([0-9a-f]{64})"/\1/p' "$test_root/repo-rules.yml")"
  fi
  printf '{"status":"success","data":{"groups":[{"name":"test","rules":['
  for name in "$@"; do
    "$first" || printf ','
    first=false
    printf '{"name":"%s","type":"alerting","health":"ok"}' "$name"
  done
  printf ',{"name":"aihub:alert_rules_fingerprint","type":"recording","health":"ok","labels":{"rules_sha256":"%s"}}]}]}}' "$fingerprint"
}

run_check() {
  PATH="$bin_dir:$PATH" \
    AIHUB_ALERT_RULES_FILE="$test_root/host-rules.yml" \
    AIHUB_HOST_JOB_METRICS_DIR="$metrics" \
    AIHUB_ALERT_RULE_DRIFT_LOG="$test_root/drift.log" \
    FAKE_REPO_RULES="$test_root/repo-rules.yml" \
    FAKE_RULES_API="$test_root/api.json" \
    "$@" bash "$script"
}

expect_failure() {
  set +e
  run_check "$@"
  local code=$?
  set -e
  [[ "$code" == 1 ]] || { printf 'expected exit 1, got %s\n' "$code" >&2; exit 1; }
  assert_contains "$metrics/alert-rule-drift-failure.prom" 'aihub_host_job_last_failure_timestamp_seconds{task="alert-rule-drift"} '
}

# Everything matches: success, with the hourly job's window, and nothing logged.
rules First Second >"$test_root/repo-rules.yml"
fingerprint_repo
cp "$test_root/repo-rules.yml" "$test_root/host-rules.yml"
api First Second >"$test_root/api.json"
run_check env
assert_contains "$metrics/alert-rule-drift-success.prom" 'aihub_host_job_last_success_timestamp_seconds{task="alert-rule-drift"} '
assert_contains "$metrics/alert-rule-drift-success.prom" 'aihub_host_job_max_age_seconds{task="alert-rule-drift"} 8400'
[[ ! -e "$test_root/drift.log" ]]

# A rule merged to main and not copied to the host.
rules First Second Third >"$test_root/repo-rules.yml"
fingerprint_repo
expect_failure env
assert_contains "$test_root/drift.log" 'alert-rule-drift failed reason=repo_differs missing_on_host=Third extra_on_host=none'

# The same names with a changed expression still differ.
rules First Second | sed 's/up == 0/up == 1/' >"$test_root/repo-rules.yml"
fingerprint_repo
: >"$test_root/drift.log"
expect_failure env
assert_contains "$test_root/drift.log" 'reason=repo_differs missing_on_host=none extra_on_host=none repo_sha256='

# Same alert names and a synchronized host file still fail when Prometheus has
# not reloaded changed rule content.
rules First Second >"$test_root/repo-rules.yml"
fingerprint_repo
old_fingerprint="$(sed -nE 's/^[[:space:]]*rules_sha256: "([0-9a-f]{64})"/\1/p' "$test_root/repo-rules.yml")"
rules First Second | sed 's/up == 0/up == 1/' >"$test_root/repo-rules.yml"
fingerprint_repo
cp "$test_root/repo-rules.yml" "$test_root/host-rules.yml"
FAKE_LOADED_FINGERPRINT=$old_fingerprint api First Second >"$test_root/api.json"
: >"$test_root/drift.log"
expect_failure env
assert_contains "$test_root/drift.log" 'reason=loaded_definition_differs expected='
unset FAKE_LOADED_FINGERPRINT

# A rule copied to the host but not loaded, because Prometheus was not reloaded.
rules First Second Third >"$test_root/repo-rules.yml"
fingerprint_repo
cp "$test_root/repo-rules.yml" "$test_root/host-rules.yml"
api First Second >"$test_root/api.json"
: >"$test_root/drift.log"
expect_failure env
assert_contains "$test_root/drift.log" 'reason=not_loaded not_loaded=Third loaded_not_in_file=none'

# The repository cannot be read.
: >"$test_root/drift.log"
expect_failure env FAKE_REPO_FAIL=1
assert_contains "$test_root/drift.log" 'reason=repo_unreadable'

# Prometheus does not answer.
api First Second Third >"$test_root/api.json"
: >"$test_root/drift.log"
expect_failure env FAKE_API_FAIL=1
assert_contains "$test_root/drift.log" 'reason=prometheus_unreachable'

# The rules file is missing on the host.
rm "$test_root/host-rules.yml"
: >"$test_root/drift.log"
expect_failure env
assert_contains "$test_root/drift.log" 'reason=host_rules_missing'

printf 'alert rule drift test passed: match, missed copy, changed expression, missed reload, unreadable repository, unreachable Prometheus, missing file\n'
