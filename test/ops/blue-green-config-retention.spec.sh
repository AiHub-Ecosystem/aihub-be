#!/usr/bin/env bash
# Pins how a deploy or rollback of one tier treats nginx and Compose inputs
# (#1174): a tier returns to the policy its release kept, and the other tier's
# live policy is never re-rendered from the synced templates. The functions are
# lifted out of the deploy script and run against fixtures, with a stand-in for
# the privileged nginx helper, so no Docker, nginx or sudo is needed.
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

assert_contains() {
  grep -Fq -- "$2" "$1" || fail "$3: '$2' not found in $1"
}

assert_lacks() {
  if grep -Fq -- "$2" "$1"; then
    fail "$3: '$2' found in $1"
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

for function_name in slot_for_port slot_for_socket active_slot port_for_slot \
  service_for_slot slot_target retarget_config config_source render_config \
  apply_slots retained_dir live_config_for retain_live_nginx prune_retained \
  retain_release_inputs select_rollback_inputs set_rollback_nginx_override \
  snapshot_live_configs; do
  definition="$(extract "$function_name" scripts/ops/blue-green/blue-green-host.sh)"
  [[ -n "$definition" ]] || fail "$function_name is missing from blue-green-host.sh"
  eval "$definition"
done

production_slot_a_port=3021
sandbox_slot_a_port=3022
socket_dir=
slot_is_socket=false
slot_listens_on_socket() { [[ "$slot_is_socket" == true ]]; }
sandbox_routed=true
nginx_override_production=""
nginx_override_sandbox=""
rollback_nginx_config=""
rollback_compose_file=docker-compose.production.yml

STATE_DIR="$test_root/state"
CONFIG_DIR="$STATE_DIR/config"
CONFIG_KEEP=3
mkdir -p "$STATE_DIR"

live_dir="$test_root/nginx"
API_CONFIG="$live_dir/aihub-api.conf"
SANDBOX_CONFIG="$live_dir/sandbox.conf"
NGINX_STAGING="$test_root/staging"
NGINX_HELPER="$test_root/apply-helper.sh"
mkdir -p "$live_dir" "$NGINX_STAGING"

# Stands in for the privileged helper: publishes the staged files, and removes
# the Sandbox config when none is staged, as the real one does.
cat >"$NGINX_HELPER" <<HELPER
#!/usr/bin/env bash
cp "$NGINX_STAGING/aihub-api.conf" "$API_CONFIG"
if [[ -f "$NGINX_STAGING/sandbox.conf" ]]; then
  cp "$NGINX_STAGING/sandbox.conf" "$SANDBOX_CONFIG"
else
  rm -f "$SANDBOX_CONFIG"
fi
HELPER
chmod +x "$NGINX_HELPER"
sudo() { shift; "$@"; }

sha_one="$(printf '1%.0s' {1..40})"
sha_two="$(printf '2%.0s' {1..40})"

# Production serves slot A with a policy that is not the synced template's, and
# Sandbox serves slot A with an older policy of its own.
seed_live() {
  render_config production a "$API_CONFIG"
  printf '# production policy N-1\n' >>"$API_CONFIG"
  render_config sandbox a "$SANDBOX_CONFIG"
  printf '# sandbox policy N-1\n' >>"$SANDBOX_CONFIG"
}

# --- a deploy of one tier leaves the other tier's live policy alone ---------
seed_live
cp "$SANDBOX_CONFIG" "$test_root/sandbox.before"
nginx_override_production=template
apply_slots b a true
assert_equals "$(active_slot production "$API_CONFIG")" b "production moved to slot B"
assert_lacks "$API_CONFIG" '# production policy N-1' "deployed tier takes the synced template"
cmp -s "$SANDBOX_CONFIG" "$test_root/sandbox.before" || fail "sandbox policy must not be re-rendered"
assert_equals "[$nginx_override_production][$nginx_override_sandbox]" "[][]" "an override never outlives one apply"

# --- the same for a Sandbox deploy ------------------------------------------
seed_live
cp "$API_CONFIG" "$test_root/production.before"
nginx_override_sandbox=template
apply_slots a b true
assert_equals "$(active_slot sandbox "$SANDBOX_CONFIG")" b "sandbox moved to slot B"
assert_lacks "$SANDBOX_CONFIG" '# sandbox policy N-1' "deployed Sandbox takes the synced template"
cmp -s "$API_CONFIG" "$test_root/production.before" || fail "production policy must not be re-rendered"

# --- a rollback returns the tier to the policy its release kept -------------
seed_live
retain_live_nginx production "$sha_one"
nginx_override_production=template
apply_slots b a true
assert_lacks "$API_CONFIG" '# production policy N-1' "the candidate policy is live"
cp "$SANDBOX_CONFIG" "$test_root/sandbox.before"
set_rollback_nginx_override production "$sha_one"
apply_slots a a true
assert_equals "$(active_slot production "$API_CONFIG")" a "production returned to slot A"
assert_contains "$API_CONFIG" '# production policy N-1' "rollback restores the release's policy"
cmp -s "$SANDBOX_CONFIG" "$test_root/sandbox.before" || fail "rollback must keep the other tier's policy"

# --- a retained policy follows the slot, port or socket ---------------------
set_rollback_nginx_override production "$sha_one"
apply_slots b a true
assert_contains "$API_CONFIG" 'proxy_pass http://127.0.0.1:3023;' "retained policy retargeted to port B"
assert_contains "$API_CONFIG" '# production policy N-1' "retargeting keeps the policy"
socket_dir=/srv/aihub/socket
slot_is_socket=true
set_rollback_nginx_override production "$sha_one"
apply_slots b a true
assert_contains "$API_CONFIG" 'proxy_pass http://unix:/srv/aihub/socket/app-slot-b.sock;' "retained policy retargeted to the socket"
assert_equals "$(grep -c 'proxy_pass http://127' "$API_CONFIG" || true)" 0 "no TCP upstream remains in a socket config"
socket_dir=
slot_is_socket=false

# --- with no live config the tier falls back to its template ----------------
rm -f "$SANDBOX_CONFIG"
apply_slots a a true
assert_lacks "$SANDBOX_CONFIG" '# sandbox policy N-1' "no live Sandbox config renders the template"
assert_equals "$(active_slot sandbox "$SANDBOX_CONFIG")" a "template render serves slot A"

# --- disabling Sandbox drops its config and keeps production ----------------
seed_live
cp "$API_CONFIG" "$test_root/production.before"
apply_slots a a false
[[ ! -e "$SANDBOX_CONFIG" ]] || fail "disabled Sandbox has no config"
cmp -s "$API_CONFIG" "$test_root/production.before" || fail "production policy survives disabling Sandbox"

# --- an unusable retained policy is refused, not rendered -------------------
printf 'server {}\n' >"$test_root/no-upstream.conf"
assert_fails retarget_config production a "$test_root/no-upstream.conf" "$test_root/out.conf"

# --- keeping a live policy before a cutover never overwrites ----------------
seed_live
rm -rf "$CONFIG_DIR"
retain_live_nginx production "$sha_two"
assert_contains "$CONFIG_DIR/production/$sha_two/nginx.conf" '# production policy N-1' "live policy kept"
printf '# a later live policy\n' >>"$API_CONFIG"
retain_live_nginx production "$sha_two"
assert_lacks "$CONFIG_DIR/production/$sha_two/nginx.conf" '# a later live policy' "an existing record is kept"
assert_fails retain_live_nginx production not-a-sha
rm -f "$SANDBOX_CONFIG"
assert_fails retain_live_nginx sandbox "$sha_one"

# --- a committed release keeps its Compose file and policy ------------------
seed_live
rm -rf "$CONFIG_DIR"
retain_release_inputs production "$sha_one"
assert_contains "$CONFIG_DIR/production/$sha_one/nginx.conf" '# production policy N-1' "release policy kept"
cmp -s docker-compose.production.yml "$CONFIG_DIR/production/$sha_one/docker-compose.production.yml" ||
  fail "release Compose file kept"
if grep -rEq 'AIHUB_[A-Z_]*(SECRET|TOKEN|PASSWORD)=' "$CONFIG_DIR"; then
  fail "no secret value may be retained"
fi

# --- only the newest releases are kept --------------------------------------
rm -rf "$CONFIG_DIR"
index=0
for digit in 3 4 5 6 7; do
  sha="$(printf "${digit}%.0s" {1..40})"
  retain_release_inputs production "$sha"
  touch -d "2026-10-0$((index + 1)) 00:00:00" "$CONFIG_DIR/production/$sha"
  index=$((index + 1))
done
prune_retained production
remaining="$(ls -1 "$CONFIG_DIR/production" | wc -l | tr -d ' ')"
assert_equals "$remaining" 3 "three releases are kept"
[[ -d "$CONFIG_DIR/production/$(printf '7%.0s' {1..40})" ]] || fail "the newest release is kept"
[[ ! -d "$CONFIG_DIR/production/$(printf '3%.0s' {1..40})" ]] || fail "the oldest release is pruned"

# --- a manual rollback picks the kept inputs, or stops before changing ------
rm -rf "$CONFIG_DIR"
select_rollback_inputs production "$sha_one" 2>/dev/null && fail "no retained inputs must stop the rollback"
assert_equals "$rollback_nginx_config" "" "nothing selected when nothing was kept"
seed_live
retain_release_inputs production "$sha_one"
select_rollback_inputs production "$sha_one"
assert_equals "$rollback_nginx_config" "$CONFIG_DIR/production/$sha_one/nginx.conf" "kept policy selected"
assert_equals "$rollback_compose_file" "$CONFIG_DIR/production/$sha_one/docker-compose.production.yml" "kept Compose file selected"

# A release kept only by the pre-cutover step has no Compose file to return to.
rm -rf "$CONFIG_DIR"
retain_live_nginx production "$sha_two"
assert_fails select_rollback_inputs production "$sha_two"
AIHUB_ROLLBACK_UNRETAINED=true select_rollback_inputs production "$sha_two" 2>/dev/null
assert_equals "$rollback_nginx_config" template "an accepted fallback renders the current template"
assert_equals "$rollback_compose_file" docker-compose.production.yml "an accepted fallback uses the current Compose file"
unset AIHUB_ROLLBACK_UNRETAINED

# --- an automatic rollback never falls back to the current templates --------
rm -rf "$CONFIG_DIR"
nginx_override_production=""
assert_fails set_rollback_nginx_override production "$sha_one"
assert_equals "$nginx_override_production" "" "a refused rollback sets no override"

# --- the live configs are kept for a failed rollback to restore -------------
seed_live
snapshot_live_configs
cmp -s "$API_CONFIG" "$STATE_DIR/live-before-rollback-production.conf" || fail "production config snapshot"
cmp -s "$SANDBOX_CONFIG" "$STATE_DIR/live-before-rollback-sandbox.conf" || fail "sandbox config snapshot"
rm -f "$SANDBOX_CONFIG"
snapshot_live_configs
[[ ! -e "$STATE_DIR/live-before-rollback-sandbox.conf" ]] || fail "a stale Sandbox snapshot is removed"

printf 'blue-green config retention spec: ok\n'
