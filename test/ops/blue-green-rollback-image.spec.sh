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

for function_name in ensure_local_image prepare_candidate rollback; do
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
registry_up=false
if message="$(rollback sandbox 2>&1 >/dev/null)"; then
  fail "rollback should fail when its image is absent and unpullable"
fi
[[ "$message" == *"$old_image"* ]] || fail "rollback should name the missing image: $message"
assert_equals "${#changed[@]}" 0 "state changed before the image was secured"
assert_no_call "compose" "rollback with a missing image"

printf 'PASS\n'
