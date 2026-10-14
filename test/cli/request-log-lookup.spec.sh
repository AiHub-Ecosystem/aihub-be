#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
lookup_script="$repository_root/scripts/ops/logs/request-log-lookup.sh"
mkdir -p "$repository_root/temp"
test_root="$(mktemp -d "$repository_root/temp/request-log-lookup.XXXXXX")"
cleanup() {
  rm -rf -- "$test_root"
  rmdir "$repository_root/temp" 2>/dev/null || true
}
trap cleanup EXIT

assert_contains() {
  grep -Fq -- "$2" "$1" || {
    printf 'expected %s to contain: %s\n' "$1" "$2" >&2
    exit 1
  }
}

assert_not_contains() {
  if grep -Fq -- "$2" "$1"; then
    printf 'expected %s not to contain: %s\n' "$1" "$2" >&2
    exit 1
  fi
}

request_id=req_01ARZ3NDEKTSV4RRFFQ69G5FAV
app_dir="$test_root/app"
fixture_dir="$test_root/fixtures"
bin_dir="$test_root/bin"
mkdir -p "$app_dir/deploy-logs" "$fixture_dir/docker" "$bin_dir"
real_zgrep="$(command -v zgrep)"
real_gzip="$(command -v gzip)"
touch "$fixture_dir/nginx-active.log"
: | "$real_gzip" -c >"$fixture_dir/nginx-rotated.log.gz"

cat >"$bin_dir/sudo" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == -n ]] || exit 90
shift
[[ "${1:-}" == docker ]] || exit 91
exec "$@"
STUB

cat >"$bin_dir/docker" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == ps ]]; then
  printf '%s\n' "$*" >>"$FAKE_DOCKER_CALLS"
  service=
  for arg in "$@"; do
    [[ "$arg" == label=com.docker.compose.service=* ]] && service="${arg##*=}"
  done
  case "$service" in
    app|app-slot-b|app-sandbox|app-sandbox-slot-b) printf '%s-container\n' "$service" ;;
    *) exit 92 ;;
  esac
  [[ "${FAKE_DOCKER_FAIL_PS:-}" != "$service" ]] || exit 95
elif [[ "${1:-}" == logs ]]; then
  printf '%s\n' "$*" >>"$FAKE_DOCKER_CALLS"
  container_id="${*: -1}"
  cat "$FAKE_DOCKER_LOGS/$container_id.log"
else
  exit 93
fi
STUB

cat >"$bin_dir/zgrep" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == -h && "${2:-}" == -F && "${3:-}" == -- ]] || exit 94
[[ "${FAKE_ZGREP_FAIL:-false}" != true ]] || exit 95
exec "$REAL_ZGREP" -h -F -- "$4" "$FAKE_NGINX_ACTIVE" "$FAKE_NGINX_ROTATED"
STUB
chmod 755 "$bin_dir/sudo" "$bin_dir/docker" "$bin_dir/zgrep"

export PATH="$bin_dir:$PATH"
export APP_DIR="$app_dir"
export FAKE_DOCKER_LOGS="$fixture_dir/docker"
export FAKE_DOCKER_CALLS="$fixture_dir/docker-calls.log"
export FAKE_NGINX_ACTIVE="$fixture_dir/nginx-active.log"
export FAKE_NGINX_ROTATED="$fixture_dir/nginx-rotated.log.gz"
export REAL_ZGREP="$real_zgrep"
export REAL_GZIP="$real_gzip"

for service in app app-slot-b app-sandbox app-sandbox-slot-b; do
  : >"$FAKE_DOCKER_LOGS/$service-container.log"
done

run_lookup() {
  if bash "$lookup_script" "$request_id" >"$test_root/output.log" 2>&1; then
    lookup_status=0
  else
    lookup_status=$?
  fi
}

run_verify() {
  if bash "$lookup_script" verify "$request_id" >"$test_root/output.log" 2>&1; then
    lookup_status=0
  else
    lookup_status=$?
  fi
}

assert_status() {
  if [[ "$lookup_status" != "$1" ]]; then
    printf 'expected lookup exit %s, got %s:\n' "$1" "$lookup_status" >&2
    cat "$test_root/output.log" >&2
    exit 1
  fi
}

write_app_event() {
  local file=$1 route=$2 status=$3 outcome=$4 error_code=${5:-}
  printf '{"event":"request_completed","request_id":"%s","client_ip":"192.0.2.10","client_ip_source":"nginx","route":"%s","http_status":%s,"outcome":"%s"' \
    "$request_id" "$route" "$status" "$outcome" >"$file"
  [[ -z "$error_code" ]] || printf ',"error_code":"%s"' "$error_code" >>"$file"
  printf ',"request_body":"body-secret","headers":{"authorization":"header-secret"},"api_key":"api-key-secret","query":"query-secret"}\n' >>"$file"
}

write_nginx_event() {
  local file=$1 method=$2 path=$3 status=$4
  printf '{"client_ip":"192.0.2.10","request_id":"%s","method":"%s","path":"%s","status":%s,"headers":"header-secret","body":"body-secret","api_key":"api-key-secret"}\n' \
    "$request_id" "$method" "$path" "$status" >"$file"
}

# Active Production and ingress logs correlate, and the CLI prints only the
# diagnostic fields even if a source line contains unrelated sensitive data.
write_app_event "$FAKE_DOCKER_LOGS/app-container.log" '/v1/items/:itemId' 200 success
write_nginx_event "$FAKE_NGINX_ACTIVE" GET '/v1/items/42?query-secret' 200
run_lookup
assert_status 0
assert_contains "$test_root/output.log" "request_id=$request_id"
assert_contains "$test_root/output.log" 'application: route=/v1/items/:itemId status=200 outcome=success'
assert_contains "$test_root/output.log" 'nginx: method=GET path=/v1/items/42 status=200'
for secret in query-secret header-secret body-secret api-key-secret; do
  assert_not_contains "$test_root/output.log" "$secret"
done
for service in app app-slot-b app-sandbox app-sandbox-slot-b; do
  assert_contains "$FAKE_DOCKER_CALLS" "label=com.docker.compose.service=$service"
  assert_contains "$FAKE_DOCKER_CALLS" "--timestamps $service-container"
done

# The release gate outputs only PASS/FAIL even though the source lines contain
# both observed addresses.
run_verify
assert_status 0
[[ "$(cat "$test_root/output.log")" == PASS ]]
assert_not_contains "$test_root/output.log" '192.0.2.10'

write_app_event "$FAKE_DOCKER_LOGS/app-container.log" '/v1/items/:itemId' 200 success
sed -i 's/"client_ip_source":"nginx"/"client_ip_source":"direct_peer"/' \
  "$FAKE_DOCKER_LOGS/app-container.log"
run_verify
assert_status 1
[[ "$(cat "$test_root/output.log")" == FAIL ]]

write_app_event "$FAKE_DOCKER_LOGS/app-container.log" '/v1/items/:itemId' 200 success
sed -i 's/"client_ip":"192.0.2.10"/"client_ip":"192.0.2.11"/' \
  "$FAKE_DOCKER_LOGS/app-container.log"
run_verify
assert_status 1
[[ "$(cat "$test_root/output.log")" == FAIL ]]

: >"$FAKE_DOCKER_LOGS/app-container.log"
: >"$FAKE_NGINX_ACTIVE"
run_verify
assert_status 1
[[ "$(cat "$test_root/output.log")" == FAIL ]]

# Container output remains searchable independently of deploy snapshots.
for service in app app-slot-b app-sandbox app-sandbox-slot-b; do
  : >"$FAKE_DOCKER_LOGS/$service-container.log"
done
rm -f "$app_dir"/deploy-logs/*.log
write_app_event "$FAKE_DOCKER_LOGS/app-slot-b-container.log" '/v1/items/:itemId' 200 success
: >"$FAKE_NGINX_ACTIVE"
write_nginx_event "$FAKE_NGINX_ACTIVE" GET '/v1/items/42' 200
run_lookup
assert_status 0
assert_contains "$test_root/output.log" 'application: route=/v1/items/:itemId status=200 outcome=success'
assert_contains "$test_root/output.log" 'nginx: method=GET path=/v1/items/42 status=200'

# A retained Sandbox snapshot and a compressed nginx rotation are searched too.
for service in app app-slot-b app-sandbox app-sandbox-slot-b; do
  : >"$FAKE_DOCKER_LOGS/$service-container.log"
done
write_app_event "$app_dir/deploy-logs/app-sandbox-aaaaaaaa-20261013.log" unmatched 404 client_error NOT_FOUND
: >"$FAKE_NGINX_ACTIVE"
write_nginx_event "$test_root/rotated-record" GET '/v1/no-such-route' 404
"$REAL_GZIP" -c "$test_root/rotated-record" >"$FAKE_NGINX_ROTATED"
run_lookup
assert_status 0
assert_contains "$test_root/output.log" 'application: route=unmatched status=404 outcome=client_error error_code=NOT_FOUND'
assert_contains "$test_root/output.log" 'nginx: method=GET path=/v1/no-such-route status=404'

# An unreadable source is reported as incomplete, never as a missing record.
: >"$FAKE_DOCKER_LOGS/app-container.log"
: >"$FAKE_NGINX_ACTIVE"
: >"$FAKE_NGINX_ROTATED"
FAKE_DOCKER_FAIL_PS=app run_lookup
assert_status 2
assert_contains "$test_root/output.log" 'application log search incomplete'
assert_not_contains "$test_root/output.log" 'application request_completed: missing'
unset FAKE_DOCKER_FAIL_PS

FAKE_ZGREP_FAIL=true run_lookup
assert_status 2
assert_contains "$test_root/output.log" 'AIHUB nginx log search incomplete'
assert_not_contains "$test_root/output.log" 'AIHUB nginx access record: missing'
unset FAKE_ZGREP_FAIL

if bash "$lookup_script" invalid-id >"$test_root/output.log" 2>&1; then
  lookup_status=0
else
  lookup_status=$?
fi
assert_status 2
assert_contains "$test_root/output.log" 'usage:'

# Report each missing side without trying to infer a match from other fields.
: >"$FAKE_NGINX_ACTIVE"
: >"$FAKE_NGINX_ROTATED"
for service in app app-slot-b app-sandbox app-sandbox-slot-b; do
  : >"$FAKE_DOCKER_LOGS/$service-container.log"
done
rm -f "$app_dir"/deploy-logs/*.log
run_lookup
assert_status 1
assert_contains "$test_root/output.log" 'application request_completed: missing'
assert_contains "$test_root/output.log" 'AIHUB nginx access record: missing'

write_app_event "$FAKE_DOCKER_LOGS/app-container.log" unmatched 404 client_error NOT_FOUND
run_lookup
assert_status 1
assert_contains "$test_root/output.log" 'application: route=unmatched status=404 outcome=client_error error_code=NOT_FOUND'
assert_contains "$test_root/output.log" 'AIHUB nginx access record: missing'

: >"$FAKE_DOCKER_LOGS/app-container.log"
write_nginx_event "$FAKE_NGINX_ACTIVE" GET '/v1/no-such-route' 404
run_lookup
assert_status 1
assert_contains "$test_root/output.log" 'application request_completed: missing'
assert_contains "$test_root/output.log" 'nginx: method=GET path=/v1/no-such-route status=404'

printf 'request-log-lookup CLI tests passed\n'
