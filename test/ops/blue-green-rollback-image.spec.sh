#!/usr/bin/env bash
# Pins how a manual rollback gets its image (#1383): an image already on the
# host is used without a registry call, an absent one is pulled, and an absent
# one that cannot be pulled stops the rollback before it changes anything. The
# functions are lifted out of the deploy script and run against stand-ins for
# Docker and Compose, so no Docker, nginx or sudo is needed.
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

# Prints one top-level function definition: from `name() {` to the first `}`
# in column 0.
extract() {
  awk -v name="$1" '
    $0 == name "() {" { printing = 1 }
    printing { print }
    printing && $0 == "}" { exit }
  ' "$2"
}

for function_name in ensure_local_image prepare_candidate rollback write_app_logging_override compose_override_supported; do
  definition="$(extract "$function_name" scripts/ops/blue-green/blue-green-host.sh)"
  [[ -n "$definition" ]] || fail "$function_name is missing from blue-green-host.sh"
  eval "$definition"
done

old_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
new_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
old_image="ghcr.io/aihub-ecosystem/aihub-be:$old_sha"

# Stand-ins for Docker. `local_images` is what the host holds; `registry_up`
# decides whether a pull can succeed.
calls=()
local_images=()
registry_up=true
sudo() { [[ "$1" != -n ]] || shift; "$@"; }
docker() {
  calls+=("docker $*")
  case "$1 $2" in
    "compose version") printf '%s\n' "$FAKE_COMPOSE_VERSION" ;;
    "image inspect")
      local image
      for image in "${local_images[@]}"; do
        [[ "$image" != "$3" ]] || return 0
      done
      return 1
      ;;
    "pull "*)
      [[ "$registry_up" == true ]] || { printf 'unauthorized\n' >&2; return 1; }
      local_images+=("$2")
      ;;
  esac
}
compose_stand_in() { calls+=("compose $*"); }
compose=(compose_stand_in)

reset_calls() {
  calls=()
  local_images=()
  registry_up=true
  skip_candidate_pull=false
}

assert_no_call() {
  local call
  for call in "${calls[@]}"; do
    [[ "$call" != $1* ]] || fail "$2: unexpected call '$call'"
  done
}

# An image already on the host is not pulled.
reset_calls
local_images=("$old_image")
ensure_local_image "$old_image" || fail "a local image should be accepted"
assert_no_call "docker pull" "local image"

# An absent image is pulled, once.
reset_calls
ensure_local_image "$old_image" || fail "a pullable image should be accepted"
assert_equals "$(printf '%s\n' "${calls[@]}" | grep -c '^docker pull ')" 1 "pulls of an absent image"

# An absent image that cannot be pulled is refused, and the message names it.
reset_calls
registry_up=false
if message="$(ensure_local_image "$old_image" 2>&1 >/dev/null)"; then
  fail "an image that is absent and unpullable should be refused"
fi
[[ "$message" == *"$old_image"* ]] || fail "the message should name the image: $message"

# Candidate startup skips the Compose pull once the rollback has the image.
capture_running_app_baseline() { :; }
save_service_logs() { :; }
assert_container_count() { :; }
wait_service_ready() { :; }
capture_resources() { :; }
container_id() { printf ''; }
candidate_restart_baseline=0

reset_calls
skip_candidate_pull=true
prepare_candidate app-sandbox-slot-b 3 false
assert_no_call "compose pull" "rollback candidate"

reset_calls
prepare_candidate app-sandbox-slot-b 3 true
[[ " ${calls[*]} " == *"compose pull app-sandbox-slot-b"* ]] || fail "a deploy candidate should still pull its image"

# A rollback whose image cannot be had stops before it changes anything.
HISTORY_FILE="$test_root/releases.tsv"
printf '2026-10-28T17:36:47Z\tdeploy\tsandbox\tb\t%s\ta\t%s\n' "$old_sha" "$new_sha" >"$HISTORY_FILE"
sandbox_enabled=true
changed=()
load_sandbox_route_state() { :; }
check_vault_agent() { :; }
select_rollback_inputs() { :; }
snapshot_live_configs() { changed+=(snapshot); }
write_image_env() { changed+=(image_env); }

reset_calls
FAKE_COMPOSE_VERSION=2.24.3
if message="$(rollback sandbox 2>&1 >/dev/null)"; then
  fail "rollback should refuse Compose older than 2.24.4"
fi
[[ "$message" == *'Docker Compose 2.24.4 or newer'* ]] || fail "rollback should explain its Compose requirement: $message"
assert_equals "${#changed[@]}" 0 "state changed before the Compose version was checked"
assert_no_call "docker pull" "rollback with unsupported Compose"

FAKE_COMPOSE_VERSION=2.24.4
registry_up=false
if message="$(rollback sandbox 2>&1 >/dev/null)"; then
  fail "rollback should fail when its image is absent and unpullable"
fi
[[ "$message" == *"$old_image"* ]] || fail "rollback should name the missing image: $message"
assert_equals "${#changed[@]}" 0 "state changed before the image was secured"
assert_no_call "compose" "rollback with a missing image"

# A successful manual rollback starts the candidate with only its logging
# override layered over the retained Compose file.
mkdir -p "$test_root/state"
STATE_DIR="$test_root/state"
printf '2026-10-28T17:36:47Z\tdeploy\tsandbox\tb\t%s\ta\t%s\n' "$old_sha" "$new_sha" >"$HISTORY_FILE"
local_images=("$old_image")
sandbox_routed=true
DEPLOY_ENV="$test_root/deploy.env"
API_CONFIG="$test_root/api.conf"
SANDBOX_CONFIG="$test_root/sandbox.conf"
rollback_compose_file="$test_root/retained-compose.yml"
rollback_nginx_config="$test_root/retained-nginx.conf"
touch "$rollback_compose_file" "$rollback_nginx_config"
load_sandbox_route_state() { sandbox_routed=true; }
select_rollback_inputs() { rollback_compose_file="$test_root/retained-compose.yml"; rollback_nginx_config="$test_root/retained-nginx.conf"; }
active_slot() { printf 'a\n'; }
service_for_slot() {
  if [[ "$1:$2" == sandbox:b ]]; then printf 'app-sandbox-slot-b\n'; else printf 'app-sandbox\n'; fi
}
container_id() {
  case "$1" in
    app-sandbox) printf 'active-sandbox-container\n' ;;
    app-sandbox-slot-b) printf 'candidate-sandbox-container\n' ;;
    *) return 1 ;;
  esac
}
container_running() { [[ "$1" == active-sandbox-container ]]; }
container_revision() { printf '%s\n' "$new_sha"; }
RECEIVER_AVAILABLE=false
RECEIVER_READY=false
apply_slots() { RECEIVER_READY="$RECEIVER_AVAILABLE"; }
start_candidate() {
  local last=$(( ${#compose[@]} - 1 ))
  [[ "${compose[last-1]}" == -f && "${compose[last]}" == *.yml ]] || fail 'added a logging override to the rollback Compose command'
  ROLLBACK_OVERRIDE_FILE="${compose[last]}"
  [[ "$RECEIVER_READY" == true ]] || { printf 'simulated rsyslog receiver is unavailable\n' >&2; return 1; }
  grep -Fq 'logging: !override' "$ROLLBACK_OVERRIDE_FILE" || fail 'used a logging-only Compose override'
  grep -Fq 'tag: aihub-sandbox' "$ROLLBACK_OVERRIDE_FILE" || fail 'used the Sandbox syslog tag'
  candidate_restart_baseline=0
}
probe_window() { :; }
probe_container_dependencies() { :; }
container_ready() { :; }
candidate_state_safe() { :; }
app_containers_safe() { :; }
drain_old_slot() { :; }
record_release() { :; }
clear_pending() { :; }
capture_resources() { :; }
edge_monitor_failures=

if rollback sandbox >"$test_root/rollback-receiver-failure.log" 2>&1; then
  fail 'refused to start a rollback candidate when the simulated receiver is unavailable'
fi
message="$(cat "$test_root/rollback-receiver-failure.log")"
[[ "$message" == *'simulated rsyslog receiver is unavailable'* ]] || fail "reported receiver unavailability: $message"
[[ ! -e "$ROLLBACK_OVERRIDE_FILE" ]] || fail 'removed the temporary override after receiver readiness failed'
[[ " ${compose[*]} " != *"$ROLLBACK_OVERRIDE_FILE"* ]] || fail 'restored the retained Compose command after receiver readiness failed'

RECEIVER_AVAILABLE=true
rollback sandbox || fail 'completed a manual rollback with the syslog override'
assert_equals "$RECEIVER_READY" true 'kept the simulated receiver available after applying the rollback route'
[[ ! -e "$ROLLBACK_OVERRIDE_FILE" ]] || fail 'removed the temporary Compose override after startup'
[[ " ${compose[*]} " != *"$ROLLBACK_OVERRIDE_FILE"* ]] || fail 'restored the retained Compose command after startup'

printf 'PASS\n'
