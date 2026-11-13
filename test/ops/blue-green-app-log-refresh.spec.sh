#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

extract() {
  awk -v name="$1" '
    $0 == name "() {" { printing = 1 }
    printing { print }
    printing && $0 == "}" { exit }
  ' "$2"
}

eval "$(extract refresh_stopped_app_logging "$repository_root/scripts/ops/blue-green/blue-green-host.sh")"
eval "$(extract deploy_tier "$repository_root/scripts/ops/blue-green/blue-green-host.sh")"

STATE_DIR="$test_root/state"
mkdir -p "$STATE_DIR"
compose=(fake_compose --env-file .env.production --profile blue-green -f docker-compose.production.yml)
ACTIVE_CONTAINER=old-container
CANDIDATE_CONTAINER=candidate-container
COMPOSE_FAIL=false
SAVED_SNAPSHOT=false
ROLLBACK_CALLED=false
COMPOSE_STOPPED=false
OLD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
AIHUB_IMAGE=ghcr.io/aihub-ecosystem/aihub-be:current
candidate_restart_baseline=0
edge_monitor_failures=

container_id() {
  case "$1" in
    app) printf '%s\n' "$ACTIVE_CONTAINER" ;;
    app-slot-b) printf '%s\n' "$CANDIDATE_CONTAINER" ;;
    *) return 1 ;;
  esac
}

container_revision() { printf '%s\n' "$OLD_SHA"; }
save_service_logs() { SAVED_SNAPSHOT=true; }

sudo() {
  [[ "${1:-}" == -n ]] || return 80
  shift
  [[ "${1:-}" == docker && "${2:-}" == inspect && "${3:-}" == --format ]] || return 81
  local format="$4" id="$5"
  case "$format" in
    '{{.HostConfig.LogConfig.Type}}')
      [[ "$id" == old-container ]] && printf 'json-file\n' || printf 'syslog\n'
      ;;
    '{{index .HostConfig.LogConfig.Config "cache-disabled"}}')
      [[ "$id" == old-container ]] && printf 'false\n' || printf 'true\n'
      ;;
    '{{.State.Running}}') printf 'false\n' ;;
    '{{.Config.Image}}') printf 'ghcr.io/aihub-ecosystem/aihub-be:previous\n' ;;
    *) return 82 ;;
  esac
}

fake_compose() {
  local operation= argument
  for argument in "$@"; do
    [[ "$argument" != up && "$argument" != stop ]] || operation="$argument"
  done
  if [[ "$operation" == up ]]; then
    [[ "$SAVED_SNAPSHOT" == true ]] || fail 'snapshotted the legacy container before recreation'
    local previous_file= expect_file=false
    while (( $# )); do
      if [[ "$expect_file" == true ]]; then
        previous_file="$1"
        expect_file=false
      elif [[ "$1" == --env-file ]]; then
        expect_file=true
      fi
      shift
    done
    [[ -n "$previous_file" ]] || fail 'provided the old image as a Compose override'
    grep -Fxq 'AIHUB_IMAGE=ghcr.io/aihub-ecosystem/aihub-be:previous' "$previous_file" ||
      fail 'used the existing container image for the rollback slot'
    [[ "$COMPOSE_FAIL" != true ]] || return 1
    ACTIVE_CONTAINER=replacement-container
  elif [[ "$operation" == stop ]]; then
    COMPOSE_STOPPED=true
    [[ "${*: -1}" == app ]] || fail 'stopped the refreshed rollback slot'
  fi
}

# A legacy stopped slot is snapshotted before replacement, recreated with its
# original image and the age-managed syslog options, then left stopped for rollback.
refresh_stopped_app_logging app || fail 'legacy app logging refresh should succeed'
[[ "$ACTIVE_CONTAINER" == replacement-container ]] || fail 'replaced the legacy container'
[[ "$COMPOSE_STOPPED" == false ]] || fail 'recreated the rollback slot without starting it'

# If recreation fails after the candidate cutover, deploy_tier invokes its
# existing rollback path and the stopped legacy container remains available.
ACTIVE_CONTAINER=old-container
COMPOSE_FAIL=true
SAVED_SNAPSHOT=false
ROLLBACK_CALLED=false
COMPOSE_STOPPED=false
active_slot() { printf 'a\n'; }
other_slot() { printf 'b\n'; }
service_for_slot() {
  [[ "$2" == a ]] && printf 'app\n' || printf 'app-slot-b\n'
}
container_running() { [[ "$1" == old-container ]]; }
retain_live_nginx() { return 0; }
write_pending() { return 0; }
start_candidate() { return 0; }
apply_slots() { return 0; }
probe_window() { return 0; }
probe_container_dependencies() { return 0; }
container_ready() { return 0; }
candidate_state_safe() { return 0; }
app_containers_safe() { return 0; }
capture_resources() { return 0; }
drain_old_slot() { return 0; }
rollback_current_tier() { ROLLBACK_CALLED=true; return 0; }
sandbox_routed=true
edge_monitor_failures=
production_host=api.aihubproduction.com
sandbox_host=sandbox.aihubproduction.com
production_slot_a_port=3021
sandbox_slot_a_port=3022
socket_dir=
slot_is_socket() { return 1; }
inject_failure=false
if deploy_tier production; then
  fail 'deployment must fail when legacy logging could not be refreshed'
fi
[[ "$SAVED_SNAPSHOT" == true ]] || fail 'saved the legacy logs before a failed refresh'
[[ "$ACTIVE_CONTAINER" == old-container ]] || fail 'kept the rollback container after refresh failure'
[[ "$ROLLBACK_CALLED" == true ]] || fail 'rolled back the cutover after refresh failure'

printf 'blue-green app-log refresh spec: ok\n'
