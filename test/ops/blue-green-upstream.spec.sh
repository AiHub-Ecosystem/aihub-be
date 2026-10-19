#!/usr/bin/env bash
# Pins how a deployment slot maps to its nginx upstream, which is either the
# slot's published TCP port or, once the apps listen on a Unix socket, its
# socket file. The functions are lifted out of the deploy script and the status
# report and run against fixtures, so no Docker, nginx or sudo is needed.
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

assert_fails() {
  if "$@" >/dev/null 2>&1; then
    fail "expected failure: $*"
  fi
}

# Prints one top-level function definition: from `name() {` to the first `}`
# in column 0.
extract() {
  awk -v name="$1" '
    $0 == name "() {" { printing = 1 }
    printing { print }
    printing && $0 == "}" { exit }
  ' "$2"
}

for function_name in slot_for_port slot_for_socket active_slot render_config \
  port_for_slot service_for_slot; do
  definition="$(extract "$function_name" scripts/ops/blue-green/blue-green-host.sh)"
  [[ -n "$definition" ]] || fail "$function_name is missing from blue-green-host.sh"
  eval "$definition"
done
eval "$(extract active_upstream ops/status.sh)"

production_slot_a_port=3021
sandbox_slot_a_port=3022
socket_dir=
slot_is_socket=false
slot_listens_on_socket() { [[ "$slot_is_socket" == true ]]; }

config() {
  printf 'server {\n  location / {\n    proxy_pass %s;\n  }\n}\n' "$1" >"$test_root/nginx.conf"
  printf '%s\n' "$test_root/nginx.conf"
}

# --- reading the active slot from a rendered config -------------------------
assert_equals "$(active_slot production "$(config http://127.0.0.1:3021)")" a "production port A"
assert_equals "$(active_slot production "$(config http://127.0.0.1:3023)")" b "production port B"
assert_equals "$(active_slot sandbox "$(config http://127.0.0.1:3022)")" a "sandbox port A"
assert_equals "$(active_slot sandbox "$(config http://127.0.0.1:3024)")" b "sandbox port B"
assert_equals "$(active_slot production "$(config http://unix:/srv/aihub/socket/app.sock)")" a "production socket A"
assert_equals "$(active_slot production "$(config http://unix:/srv/aihub/socket/app-slot-b.sock)")" b "production socket B"
assert_equals "$(active_slot sandbox "$(config http://unix:/srv/aihub/socket/app-sandbox.sock)")" a "sandbox socket A"
assert_equals "$(active_slot sandbox "$(config http://unix:/srv/aihub/socket/app-sandbox-slot-b.sock)")" b "sandbox socket B"

# A socket belongs to one tier, and an unknown file name is refused.
assert_fails active_slot production "$(config http://unix:/srv/aihub/socket/app-sandbox.sock)"
assert_fails active_slot sandbox "$(config http://unix:/srv/aihub/socket/app.sock)"
assert_fails active_slot production "$(config http://unix:/srv/aihub/socket/other.sock)"
assert_fails active_slot production "$(config http://127.0.0.1:9999)"

# Two different upstreams in one file are never a single active slot.
printf 'proxy_pass http://127.0.0.1:3021;\nproxy_pass http://unix:/srv/aihub/socket/app.sock;\n' \
  >"$test_root/mixed.conf"
assert_fails active_slot production "$test_root/mixed.conf"

# --- the status report reads the same two forms -----------------------------
assert_equals "$(active_upstream "$(config http://127.0.0.1:3021)")" "127.0.0.1:3021" "status port"
assert_equals "$(active_upstream "$(config http://unix:/srv/aihub/socket/app-slot-b.sock)")" \
  "unix:/srv/aihub/socket/app-slot-b.sock" "status socket"

# --- rendering --------------------------------------------------------------
render() {
  render_config "$1" "$2" "$test_root/rendered.conf"
  printf '%s\n' "$test_root/rendered.conf"
}

# Socket off: a slot is reached by its port, whatever the container reports.
socket_dir=
slot_is_socket=true
assert_equals "$(active_slot production "$(render production b)")" b "socket off renders port B"
grep -Fq 'proxy_pass http://127.0.0.1:3023;' "$test_root/rendered.conf" || fail "socket off keeps port 3023"

# Socket on, container started with it: nginx gets the socket path.
socket_dir=/srv/aihub/socket
slot_is_socket=true
assert_equals "$(active_slot production "$(render production b)")" b "socket B round-trips"
grep -Fq 'proxy_pass http://unix:/srv/aihub/socket/app-slot-b.sock;' "$test_root/rendered.conf" || fail "socket path rendered"
if grep -Fq '127.0.0.1' "$test_root/rendered.conf"; then
  fail "no TCP upstream may remain in a socket config"
fi
assert_equals "$(grep -c 'proxy_pass' "$test_root/rendered.conf")" 3 "every location is rewritten"
assert_equals "$(active_slot sandbox "$(render sandbox a)")" a "sandbox socket A round-trips"
grep -Fq 'proxy_pass http://unix:/srv/aihub/socket/app-sandbox.sock;' "$test_root/rendered.conf" || fail "sandbox socket path rendered"

# Socket on, but the slot's container predates it: a rollback target keeps its port.
slot_is_socket=false
assert_equals "$(active_slot production "$(render production a)")" a "old container renders port A"
grep -Fq 'proxy_pass http://127.0.0.1:3021;' "$test_root/rendered.conf" || fail "old container keeps port 3021"

printf 'blue-green upstream spec: ok\n'
