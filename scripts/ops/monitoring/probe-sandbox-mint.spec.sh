#!/usr/bin/env bash
# Exercises scripts/ops/monitoring/probe-sandbox-mint.sh with a stubbed curl: a minted
# assertion records success, a refusal after one retry records failure and
# logs only the error code, the key never reaches argv or the log, and a key
# file with the wrong mode is refused.
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
script="$repository_root/scripts/ops/monitoring/probe-sandbox-mint.sh"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

bin_dir="$test_root/bin"
metrics="$test_root/metrics"
mkdir -p "$bin_dir"

assert_contains() {
  grep -Fq -- "$2" "$1" || { printf 'expected %s to contain: %s\n' "$1" "$2" >&2; cat "$1" >&2; exit 1; }
}
assert_not_contains() {
  if grep -Fq -- "$2" "$1"; then printf 'expected %s not to contain: %s\n' "$1" "$2" >&2; exit 1; fi
}

# curl -sS -o <body> -w '%{http_code}' ... -H @<fd> ...: records argv and the
# header file it was handed, then answers with FAKE_STATUS and FAKE_BODY.
cat >"$bin_dir/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_CURL_ARGV"
out=
while (( $# )); do
  case "$1" in
    -o) out=$2; shift ;;
    -H) [[ "$2" == @* ]] && cat "${2#@}" >>"$FAKE_CURL_HEADERS"; shift ;;
  esac
  shift
done
printf '%s' "$FAKE_BODY" >"$out"
printf '%s' "$FAKE_STATUS"
STUB
chmod 755 "$bin_dir/curl"

key_file="$test_root/key"
printf 'aihub_sandbox_testsecretvalue\n' >"$key_file"
chmod 600 "$key_file"

run_probe() {
  PATH="$bin_dir:$PATH" \
    AIHUB_SANDBOX_PROBE_KEY_FILE="$key_file" \
    AIHUB_HOST_JOB_METRICS_DIR="$metrics" \
    AIHUB_SANDBOX_PROBE_LOG="$test_root/probe.log" \
    AIHUB_SANDBOX_PROBE_RETRY_DELAY=0 \
    FAKE_CURL_ARGV="$test_root/argv" \
    FAKE_CURL_HEADERS="$test_root/headers" \
    "$@" bash "$script"
}

: >"$test_root/argv"
: >"$test_root/headers"
run_probe env FAKE_STATUS=200 FAKE_BODY='{"data":{"assertion":"eyJhbGciOi.x.y","expires_at":1}}'
assert_contains "$metrics/sandbox-mint-probe-success.prom" 'aihub_host_job_last_success_timestamp_seconds{task="sandbox-mint-probe"} '
assert_contains "$metrics/sandbox-mint-probe-success.prom" 'aihub_host_job_max_age_seconds{task="sandbox-mint-probe"} 300'
assert_contains "$test_root/headers" 'X-API-Key: aihub_sandbox_testsecretvalue'
assert_not_contains "$test_root/argv" 'testsecretvalue'
[[ "$(wc -l <"$test_root/argv")" == 1 ]]
[[ ! -e "$test_root/probe.log" ]]

# A refusal is retried once, then recorded with its error code only.
: >"$test_root/argv"
set +e
run_probe env FAKE_STATUS=403 FAKE_BODY='{"error":{"code":"FORBIDDEN","message":"no"}}'
code=$?
set -e
[[ "$code" == 1 ]]
[[ "$(wc -l <"$test_root/argv")" == 2 ]]
assert_contains "$metrics/sandbox-mint-probe-failure.prom" 'aihub_host_job_last_failure_timestamp_seconds{task="sandbox-mint-probe"} '
assert_contains "$test_root/probe.log" 'sandbox-mint-probe failed reason=http_403 error=FORBIDDEN'

# A 200 without an assertion is not a success.
set +e
run_probe env FAKE_STATUS=200 FAKE_BODY='{"data":{}}'
code=$?
set -e
[[ "$code" == 1 ]]
assert_contains "$test_root/probe.log" 'reason=http_200 error=none'
assert_not_contains "$test_root/probe.log" 'testsecretvalue'

# A key file another account can read is refused before any request. Skipped
# off Linux, where Git Bash on NTFS reports file modes from its own emulation.
chmod 644 "$key_file"
if [[ "$(uname -s)" == Linux ]]; then
  : >"$test_root/argv"
  set +e
  run_probe env FAKE_STATUS=200 FAKE_BODY='{}'
  code=$?
  set -e
  [[ "$code" == 1 ]]
  [[ ! -s "$test_root/argv" ]]
  assert_contains "$test_root/probe.log" 'reason=key_not_mode_600'
fi

printf 'sandbox mint probe test passed: success, retried refusal, empty 200, key mode, no key in argv or log\n'
