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
eval "$(extract replace_app_container_baseline "$repository_root/scripts/ops/blue-green/blue-green-host.sh")"
eval "$(extract compose_override_supported "$repository_root/scripts/ops/blue-green/blue-green-host.sh")"
eval "$(extract deploy_tier "$repository_root/scripts/ops/blue-green/blue-green-host.sh")"

STATE_DIR="$test_root/state"
OLD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OLD_IMAGE="ghcr.io/aihub-ecosystem/aihub-be:$OLD_SHA"
retained_compose="$test_root/config/production/$OLD_SHA/docker-compose.production.yml"
mkdir -p "$(dirname "$retained_compose")" "$STATE_DIR"
printf 'services:\n  app:\n    image: retained-old-release\n' >"$retained_compose"
compose=(fake_compose --env-file .env.production --profile blue-green -f docker-compose.production.yml)
ACTIVE_CONTAINER=old-container
CANDIDATE_CONTAINER=candidate-container
COMPOSE_FAIL=false
SAVED_SNAPSHOT=false
ROLLBACK_CALLED=false
COMPOSE_STOPPED=false
AIHUB_IMAGE=ghcr.io/aihub-ecosystem/aihub-be:current
API_CONFIG="$test_root/nginx-api.conf"
SANDBOX_CONFIG="$test_root/nginx-sandbox.conf"
candidate_restart_baseline=0
edge_monitor_failures=
app_container_baseline_ids=(old-container candidate-container)
app_container_baseline_restarts=(0 0)

container_id() {
  case "$1" in
    app) printf '%s\n' "$ACTIVE_CONTAINER" ;;
    app-slot-b) printf '%s\n' "$CANDIDATE_CONTAINER" ;;
    *) return 1 ;;
  esac
}

container_revision() { printf '%s\n' "$OLD_SHA"; }
save_service_logs() { SAVED_SNAPSHOT=true; }
retained_dir() { printf '%s/config/%s/%s\n' "$test_root" "$1" "$2"; }

sudo() {
  [[ "${1:-}" == -n ]] || return 80
  shift
  if [[ "${1:-}" == docker && "${2:-}" == compose && "${3:-}" == version ]]; then
    printf '%s\n' "$FAKE_COMPOSE_VERSION"
    return 0
  fi
  [[ "${1:-}" == docker && "${2:-}" == inspect && "${3:-}" == --format ]] || return 81
  local format="$4" id="$5"
  case "$format" in
    '{{.HostConfig.LogConfig.Type}}')
      [[ "$id" == old-container || "$id" == restored-container ]] && printf 'json-file\n' || printf 'syslog\n'
      ;;
    '{{index .HostConfig.LogConfig.Config "cache-disabled"}}')
      [[ "$id" == old-container || "$id" == restored-container ]] && printf 'false\n' || printf 'true\n'
      ;;
    '{{.State.Running}}') printf 'false\n' ;;
    '{{.Config.Image}}') printf '%s\n' "$OLD_IMAGE" ;;
    '{{.State.Status}} {{.State.OOMKilled}} {{.RestartCount}}') printf 'created false 0\n' ;;
    *) return 82 ;;
  esac
}

FAKE_COMPOSE_VERSION=v2.24.4
compose_override_supported || fail 'accepted Compose 2.24.4'
FAKE_COMPOSE_VERSION=5.5.0
compose_override_supported || fail 'accepted Compose 5.x'
FAKE_COMPOSE_VERSION=2.24.3
if compose_override_supported; then
  fail 'rejected Compose older than 2.24.4'
fi

fake_compose() {
  local operation= previous_file= override_file= env_file= pending=
  local argument
  while (( $# )); do
    argument="$1"
    shift
    if [[ -n "$pending" ]]; then
      case "$pending" in
        env-file) env_file="$argument" ;;
        file) [[ -z "$previous_file" ]] && previous_file="$argument" || override_file="$argument" ;;
      esac
      pending=
      continue
    fi
    case "$argument" in
      up | stop) operation="$argument" ;;
      --env-file) pending=env-file ;;
      -f | --file) pending=file ;;
    esac
  done
  if [[ "$operation" == up ]]; then
    [[ "$SAVED_SNAPSHOT" == true ]] || fail 'snapshotted the legacy container before recreation'
    [[ "$previous_file" == "$retained_compose" ]] || fail 'used the retained Compose config for the old release'
    [[ -n "$env_file" ]] || fail 'provided the old image as a Compose environment override'
    grep -Fxq "AIHUB_IMAGE=$OLD_IMAGE" "$env_file" || fail 'used the existing container image for the rollback slot'
    if [[ -n "$override_file" ]]; then
      grep -Fq 'logging: !override' "$override_file" || fail 'replaced the old driver options instead of merging them'
      grep -Fq 'tag: aihub-production' "$override_file" || fail 'used the Production syslog tag'
      if [[ "$COMPOSE_FAIL" == true ]]; then
        ACTIVE_CONTAINER=missing-container
        return 1
      fi
      ACTIVE_CONTAINER=replacement-container
    else
      ACTIVE_CONTAINER=restored-container
    fi
  elif [[ "$operation" == stop ]]; then
    COMPOSE_STOPPED=true
    [[ "${*: -1}" == app ]] || fail 'stopped the refreshed rollback slot'
  fi
}

# A legacy stopped slot is snapshotted before replacement, recreated from its
# retained release Compose file, and given only a syslog override. The new ID
# replaces the stopped slot in the rollout baseline.
refresh_stopped_app_logging production app "$OLD_SHA" || fail 'legacy app logging refresh should succeed'
[[ "$ACTIVE_CONTAINER" == replacement-container ]] || fail 'replaced the legacy container'
[[ "$COMPOSE_STOPPED" == false ]] || fail 'recreated the rollback slot without starting it'
[[ "${app_container_baseline_ids[0]}" == replacement-container ]] || fail 'updated the replaced container baseline'

# If recreation fails after the candidate cutover, the helper restores the old
# Compose container before deploy_tier invokes its existing rollback path.
ACTIVE_CONTAINER=old-container
COMPOSE_FAIL=true
SAVED_SNAPSHOT=false
ROLLBACK_CALLED=false
COMPOSE_STOPPED=false
app_container_baseline_ids=(old-container candidate-container)
app_container_baseline_restarts=(0 0)
active_slot() { printf 'a\n'; }
other_slot() { printf 'b\n'; }
service_for_slot() {
  [[ "$2" == a ]] && printf 'app\n' || printf 'app-slot-b\n'
}
container_running() { [[ "$1" == old-container ]]; }
retain_live_nginx() { return 0; }
write_pending() { return 0; }
start_candidate() {
  app_container_baseline_ids=(old-container candidate-container)
  app_container_baseline_restarts=(0 0)
  return 0
}
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
[[ "$ACTIVE_CONTAINER" == restored-container ]] || fail 'restored the old Compose container after refresh failure'
[[ "${app_container_baseline_ids[0]}" == restored-container ]] || fail 'tracked the restored rollback container'
[[ "$ROLLBACK_CALLED" == true ]] || fail 'rolled back the cutover after refresh failure'

printf 'blue-green app-log refresh spec: ok\n'
