#!/usr/bin/env bash
# Exercises ops/status.sh with stubbed Docker and readiness responses.
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

bin_dir="$test_root/bin"
config_dir="$test_root/nginx"
mkdir -p "$bin_dir" "$config_dir"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  [[ "$1" == *"$2"* ]] || fail "expected output to contain: $2"
}

assert_not_contains() {
  [[ "$1" != *"$2"* ]] || fail "expected output not to contain: $2"
}

cat >"$bin_dir/sudo" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == -n ]] && shift
exec "$@"
STUB

cat >"$bin_dir/docker" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  ps)
    case "$*" in
      *publish=3021*) printf 'production-container\n' ;;
      *publish=3022*) printf 'sandbox-container\n' ;;
      *) exit 1 ;;
    esac
    ;;
  inspect)
    if [[ "$2" == --format ]]; then
      case "$4" in
        production-container) printf 'app\n' ;;
        sandbox-container) printf 'app-sandbox\n' ;;
        *) exit 1 ;;
      esac
    elif [[ "$3" == --format ]]; then
      printf '0123456789abcdef0123456789abcdef01234567 running healthy 0 2026-10-21T00:00:00Z\n'
    else
      exit 1
    fi
    ;;
  logs) ;;
  exec)
    shift 2
    [[ "$1" == node ]] || exit 1
    shift
    exec node --require "$FAKE_FETCH_SHIM" "$@"
    ;;
  *) exit 1 ;;
esac
STUB

cat >"$test_root/fetch-stub.cjs" <<'STUB'
globalThis.fetch = async (url, { signal } = {}) => {
  if (url.endsWith('/health')) return new Response(null, { status: 200 });
  if (!url.endsWith('/ready')) return new Response(null, { status: 404 });
  if (process.env.FAKE_READY_MODE === 'timeout') {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  return new Response(process.env.FAKE_READY_BODY ?? '', {
    status: Number(process.env.FAKE_READY_STATUS ?? 200),
  });
};
STUB

chmod 755 "$bin_dir/sudo" "$bin_dir/docker"
fetch_shim="$test_root/fetch-stub.cjs"
case "$(uname -s)" in
  MINGW* | MSYS*) fetch_shim="$(cygpath -w "$fetch_shim")" ;;
esac

printf 'server {\n  location / {\n    proxy_pass http://127.0.0.1:3021;\n  }\n}\n' \
  >"$config_dir/aihub-api.conf"
printf 'server {\n  location / {\n    proxy_pass http://127.0.0.1:3022;\n  }\n}\n' \
  >"$config_dir/sandbox.conf"

# Redirect only the two host nginx paths so the real status script can run
# against temporary fixtures without needing access to /etc/nginx.
sed "s|/etc/nginx/conf.d|$config_dir|g" "$repository_root/ops/status.sh" \
  >"$test_root/status.sh"

expected_revision=0123456789abcdef0123456789abcdef01234567
all_up='{"status":"ok","dependencies":{"runtime-postgres":"up","control-plane-write-postgres":"up","control-plane-read-postgres":"up","redis":"up"}}'
one_down='{"status":"ok","dependencies":{"runtime-postgres":"up","control-plane-write-postgres":"up","control-plane-read-postgres":"down","redis":"up"}}'
missing_runtime='{"status":"ok","dependencies":{"redis":"up"}}'
missing_redis='{"status":"ok","dependencies":{"runtime-postgres":"up"}}'

run_status() {
  local mode="$1" http_status="$2" body="$3"
  if output="$(PATH="$bin_dir:$PATH" \
    FAKE_FETCH_SHIM="$fetch_shim" \
    FAKE_READY_MODE="$mode" \
    FAKE_READY_STATUS="$http_status" \
    FAKE_READY_BODY="$body" \
    bash "$test_root/status.sh" "$expected_revision")"; then
    exit_code=0
  else
    exit_code=$?
  fi
}

expected_dependencies='readiness_dependencies=runtime-postgres=up,control-plane-write-postgres=up,control-plane-read-postgres=up,redis=up'
run_status normal 200 "$all_up"
[[ "$exit_code" == 0 ]] || fail "all-up status exited $exit_code"
assert_contains "$output" "production ok   revision=0123456 state=running health=healthy health_probe=200 readiness_probe=200 $expected_dependencies"
assert_contains "$output" "sandbox    ok   revision=0123456 state=running health=healthy health_probe=200 readiness_probe=200 $expected_dependencies"

run_status normal 200 "$one_down"
[[ "$exit_code" == 1 ]] || fail "one dependency down exited $exit_code"
assert_contains "$output" 'production FAIL'
assert_contains "$output" 'sandbox    FAIL'
assert_contains "$output" 'readiness_probe=200 readiness_dependencies=runtime-postgres=up,control-plane-write-postgres=up,control-plane-read-postgres=down,redis=up'

run_status normal 503 "$all_up"
[[ "$exit_code" == 1 ]] || fail "non-200 readiness response exited $exit_code"
assert_contains "$output" 'readiness_probe=503 readiness_dependencies=runtime-postgres=up,control-plane-write-postgres=up,control-plane-read-postgres=up,redis=up'

run_status timeout 200 ''
[[ "$exit_code" == 1 ]] || fail "readiness timeout exited $exit_code"
assert_contains "$output" 'readiness_probe=ERR readiness_dependencies=unavailable'

run_status normal 200 '{malformed-response-secret=must-not-leak'
[[ "$exit_code" == 1 ]] || fail "malformed readiness response exited $exit_code"
assert_contains "$output" 'readiness_probe=200 readiness_dependencies=unavailable'
assert_not_contains "$output" 'malformed-response-secret'
assert_contains "$output" 'production FAIL revision=0123456 state=running health=healthy health_probe=200 readiness_probe=200 readiness_dependencies=unavailable restarts=0 errors=0 since='

run_status normal 200 '{"status":"ok"}'
[[ "$exit_code" == 1 ]] || fail "readiness response without dependencies exited $exit_code"
assert_contains "$output" 'readiness_probe=200 readiness_dependencies=unavailable'

run_status normal 200 "$missing_runtime"
[[ "$exit_code" == 1 ]] || fail "readiness response without runtime Postgres exited $exit_code"
assert_contains "$output" 'readiness_probe=200 readiness_dependencies=unavailable'

run_status normal 200 "$missing_redis"
[[ "$exit_code" == 1 ]] || fail "readiness response without Redis exited $exit_code"
assert_contains "$output" 'readiness_probe=200 readiness_dependencies=unavailable'

printf 'status readiness spec: all-up, dependency-down, timeout, and malformed response passed\n'
