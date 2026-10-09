#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly REPOSITORY_URL=https://github.com/AiHub-Ecosystem/aihub-be
readonly API_CONFIG=/etc/nginx/conf.d/aihub-api.conf
readonly SANDBOX_CONFIG=/etc/nginx/conf.d/sandbox.conf
readonly NGINX_STAGING=/var/lib/aihub-nginx-staging
readonly NGINX_HELPER=/usr/local/sbin/aihub-nginx-apply
readonly STATE_DIR=.aihub-deploy-state
readonly HISTORY_FILE=$STATE_DIR/releases.tsv
readonly PENDING_FILE=$STATE_DIR/pending.tsv
readonly DEPLOY_ENV=.aihub-deploy.env
readonly LOCK_FILE=.aihub-deploy.lock

APP_DIR=${APP_DIR:?APP_DIR is required}
AIHUB_IMAGE=${AIHUB_IMAGE:-}
COMMAND=${1:-}
TIER=${2:-}
candidate_restart_baseline=0

cd "$APP_DIR"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf 'another AIHUB deployment or rollback is already running\n' >&2
  exit 1
fi

read_env() {
  local key="$1"
  sed -n "s/^${key}=//p" .env.production | tail -n 1 | tr -d '\r'
}

sandbox_enabled="$(read_env AIHUB_SANDBOX_ENABLED)"
if [[ -z "$sandbox_enabled" ]]; then
  sandbox_enabled=false
fi
if [[ "$sandbox_enabled" != true && "$sandbox_enabled" != false ]]; then
  printf 'AIHUB_SANDBOX_ENABLED must be true or false\n' >&2
  exit 1
fi

production_host="$(read_env AIHUB_PRODUCTION_HOST)"
sandbox_host="$(read_env AIHUB_SANDBOX_HOST)"
if [[ -z "$production_host" ]]; then
  printf 'AIHUB_PRODUCTION_HOST is required\n' >&2
  exit 1
fi
if [[ "$sandbox_enabled" == true && -z "$sandbox_host" ]]; then
  printf 'AIHUB_SANDBOX_HOST is required when Sandbox is enabled\n' >&2
  exit 1
fi

write_image_env() {
  local image="$1"
  [[ "$image" =~ ^ghcr\.io/aihub-ecosystem/aihub-be:[a-f0-9]{40}$ ]] || {
    printf 'AIHUB_IMAGE must be an immutable AIHUB commit-SHA image\n' >&2
    return 1
  }
  printf 'AIHUB_IMAGE=%s\n' "$image" >"$DEPLOY_ENV"
  chmod 600 "$DEPLOY_ENV"
  AIHUB_IMAGE="$image"
}

if [[ -n "$AIHUB_IMAGE" ]]; then
  write_image_env "$AIHUB_IMAGE"
fi

compose=(sudo -n docker compose --env-file .env.production)
if [[ -f "$DEPLOY_ENV" ]]; then
  compose+=(--env-file "$DEPLOY_ENV")
fi
compose+=(-f docker-compose.production.yml --profile blue-green)
if [[ "$sandbox_enabled" == true ]]; then
  compose+=(--profile sandbox)
fi

slot_for_port() {
  local tier="$1" port="$2"
  case "$tier:$port" in
    production:3021 | sandbox:3022) printf a ;;
    production:3023 | sandbox:3024) printf b ;;
    *) printf 'unsupported %s upstream port: %s\n' "$tier" "$port" >&2; return 1 ;;
  esac
}

port_for_slot() {
  case "$1:$2" in
    production:a) printf 3021 ;;
    production:b) printf 3023 ;;
    sandbox:a) printf 3022 ;;
    sandbox:b) printf 3024 ;;
    *) printf 'unknown deployment slot: %s %s\n' "$1" "$2" >&2; return 1 ;;
  esac
}

other_slot() {
  [[ "$1" == a ]] && printf b || printf a
}

service_for_slot() {
  case "$1:$2" in
    production:a) printf app ;;
    production:b) printf app-slot-b ;;
    sandbox:a) printf app-sandbox ;;
    sandbox:b) printf app-sandbox-slot-b ;;
    *) printf 'unknown deployment slot: %s %s\n' "$1" "$2" >&2; return 1 ;;
  esac
}

active_slot() {
  local tier="$1" config="$2"
  local ports=()
  mapfile -t ports < <(sed -nE 's#^[[:space:]]*proxy_pass http://127\.0\.0\.1:([0-9]+);.*#\1#p' "$config" | sort -u)
  if [[ "${#ports[@]}" -ne 1 ]]; then
    printf '%s nginx config must have exactly one active upstream port\n' "$tier" >&2
    return 1
  fi
  slot_for_port "$tier" "${ports[0]}"
}

container_id() {
  local service="$1"
  "${compose[@]}" ps --all --quiet "$service" | head -n 1
}

container_revision() {
  local id="$1"
  [[ -n "$id" ]] || { printf 'missing application container\n' >&2; return 1; }
  sudo -n docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$id"
}

container_running() {
  local id="$1"
  [[ "$(sudo -n docker inspect --format '{{.State.Running}}' "$id")" == true ]]
}

container_ready() {
  local id="$1" status="$2"
  [[ "$status" == healthy ]] || return 1
  sudo -n docker exec "$id" node -e \
    "fetch('http://127.0.0.1:3000/ready').then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))" \
    >/dev/null 2>&1
}

candidate_state_safe() {
  local id="$1" baseline_restart_count="$2" state status oom_killed restart_count
  state="$(sudo -n docker inspect --format '{{.State.Status}} {{.State.OOMKilled}} {{.RestartCount}}' "$id")" || return 1
  read -r status oom_killed restart_count <<<"$state"
  if [[ "$status" != running || "$oom_killed" != false || "$restart_count" != "$baseline_restart_count" ]]; then
    printf 'candidate state is unsafe status=%s oom_killed=%s restart_count=%s baseline=%s\n' \
      "$status" "$oom_killed" "$restart_count" "$baseline_restart_count" >&2
    return 1
  fi
}

probe_container_dependencies() {
  sudo -n docker exec "$1" node scripts/ops/probe-runtime-dependencies.cjs
}

probe_host() {
  local tier="$1" hostname="$2" status started_at
  started_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  status="$(curl --silent --show-error --max-time 4 -o /dev/null -w '%{http_code}' \
    "https://${hostname}/health" 2>/dev/null || printf request_error)"
  printf '%s\t%s\t%s\t%s\n' "$started_at" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$tier" "$status" \
    >>"$STATE_DIR/edge-probes.tsv" || {
    printf 'could not record public edge probe for %s\n' "$tier" >&2
    return 1
  }
  if [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
    return 0
  fi
  printf 'public /health failed for %s: %s\n' "$tier" "$status" >&2
  return 1
}

probe_all() {
  local failed=0 production_pid sandbox_pid=
  probe_host production "$production_host" &
  production_pid="$!"
  if [[ "$sandbox_enabled" == true ]]; then
    probe_host sandbox "$sandbox_host" &
    sandbox_pid="$!"
  fi
  wait "$production_pid" || failed=1
  [[ -z "$sandbox_pid" ]] || wait "$sandbox_pid" || failed=1
  return "$failed"
}

probe_window() {
  local seconds="$1" failed=0 attempt next_at delay running_pids pid
  local -a probe_pids=() pending_pids=()
  next_at=$SECONDS
  for ((attempt = 0; attempt < seconds; attempt += 1)); do
    delay=$((next_at - SECONDS))
    if ((delay > 0)); then sleep "$delay"; fi
    probe_host production "$production_host" &
    probe_pids+=("$!")
    if [[ "$sandbox_enabled" == true ]]; then
      probe_host sandbox "$sandbox_host" &
      probe_pids+=("$!")
    fi
    next_at=$((next_at + 1))
    running_pids=" $(jobs -pr | tr '\n' ' ') "
    pending_pids=()
    for pid in "${probe_pids[@]}"; do
      if [[ "$running_pids" == *" $pid "* ]]; then
        pending_pids+=("$pid")
      elif ! wait "$pid"; then
        failed=1
      fi
    done
    probe_pids=("${pending_pids[@]}")
  done
  for pid in "${probe_pids[@]}"; do
    wait "$pid" || failed=1
  done
  return "$failed"
}

render_config() {
  local tier="$1" slot="$2" output="$3" template default_port target_port ports=()
  default_port=3021
  template=ops/nginx/aihub-api.conf
  if [[ "$tier" == sandbox ]]; then
    default_port=3022
    template=ops/nginx/sandbox.conf
  fi
  target_port="$(port_for_slot "$tier" "$slot")"
  mapfile -t ports < <(sed -nE 's#^[[:space:]]*proxy_pass http://127\.0\.0\.1:([0-9]+);.*#\1#p' "$template" | sort -u)
  if [[ "${#ports[@]}" -ne 1 || "${ports[0]}" != "$default_port" ]]; then
    printf '%s nginx source must use its slot-A port %s\n' "$tier" "$default_port" >&2
    return 1
  fi
  sed -E "s#(proxy_pass[[:space:]]+http://127\\.0\\.0\\.1:)[0-9]+;#\\1${target_port};#g" "$template" >"$output"
}

apply_slots() {
  local api_slot="$1" sandbox_slot="$2" api_tmp sandbox_tmp
  api_tmp="$(mktemp)"
  sandbox_tmp="$(mktemp)"
  render_config production "$api_slot" "$api_tmp"
  if [[ "$sandbox_enabled" == true ]]; then
    render_config sandbox "$sandbox_slot" "$sandbox_tmp"
  fi
  install -o "$(id -u)" -g "$(id -g)" -m 0644 "$api_tmp" "$NGINX_STAGING/aihub-api.conf"
  if [[ "$sandbox_enabled" == true ]]; then
    install -o "$(id -u)" -g "$(id -g)" -m 0644 "$sandbox_tmp" "$NGINX_STAGING/sandbox.conf"
  else
    rm -f "$NGINX_STAGING/sandbox.conf"
  fi
  rm -f "$api_tmp" "$sandbox_tmp"
  sudo -n "$NGINX_HELPER"
  [[ "$(active_slot production "$API_CONFIG")" == "$api_slot" ]]
  if [[ "$sandbox_enabled" == true ]]; then
    [[ "$(active_slot sandbox "$SANDBOX_CONFIG")" == "$sandbox_slot" ]]
  fi
}

app_container_names() {
  sudo -n docker ps --filter "label=org.opencontainers.image.source=${REPOSITORY_URL}" --format '{{.Names}} {{.Status}}'
}

assert_container_count() {
  local expected="$1" names count
  names="$(app_container_names)"
  count="$(printf '%s\n' "$names" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
  if [[ "$count" -ne "$expected" ]]; then
    printf 'AIHUB application container count is %s; expected %s. Review unmanaged or stale containers before rollout.\n%s\n' \
      "$count" "$expected" "$names" >&2
    return 1
  fi
}

capture_resources() {
  local label="$1" log="$STATE_DIR/resources-$(date -u +%Y%m%dT%H%M%SZ).log"
  {
    printf 'label=%s at=%s\n' "$label" "$(date -u +%FT%TZ)"
    printf 'vcpus=%s\n' "$(nproc)"
    free -b
    sudo -n docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.MemPerc}}'
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      sudo -n docker inspect --format \
        '{{.Name}} revision={{index .Config.Labels "org.opencontainers.image.revision"}} state={{.State.Status}} oom_killed={{.State.OOMKilled}} restart_count={{.RestartCount}}' \
        "$id"
    done < <(sudo -n docker ps -aq --filter "label=org.opencontainers.image.source=${REPOSITORY_URL}")
  } >>"$log"
  chmod 600 "$log"
  printf 'resource evidence: %s\n' "$log"
}

write_pending() {
  local tier="$1" old_slot="$2" old_sha="$3" new_slot="$4" new_sha="$5"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%FT%TZ)" "$tier" "$old_slot" "$old_sha" "$new_slot" "$new_sha" >"$PENDING_FILE.tmp"
  chmod 600 "$PENDING_FILE.tmp"
  mv "$PENDING_FILE.tmp" "$PENDING_FILE"
}

clear_pending() {
  rm -f "$PENDING_FILE" "$PENDING_FILE.tmp"
}

record_release() {
  local operation="$1" tier="$2" old_slot="$3" old_sha="$4" new_slot="$5" new_sha="$6"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%FT%TZ)" "$operation" "$tier" "$old_slot" "$old_sha" "$new_slot" "$new_sha" >>"$HISTORY_FILE"
  chmod 600 "$HISTORY_FILE"
}

wait_service_ready() {
  local service="$1" timeout_seconds="${2:-120}" expected_id="${3:-}" expected_restart_count="${4:-}" check_edge="${5:-true}" id status
  for ((attempt = 0; attempt < timeout_seconds; attempt += 1)); do
    if [[ "$check_edge" == true ]]; then
      probe_all || return 1
    fi
    id="$(container_id "$service")"
    if [[ -n "$id" ]]; then
      if [[ -n "$expected_restart_count" ]]; then
        [[ "$id" == "$expected_id" ]] && candidate_state_safe "$id" "$expected_restart_count" || return 1
      fi
      status="$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null || true)"
      if container_ready "$id" "$status"; then
        printf '%s ready revision=%s\n' "$service" "$(container_revision "$id")"
        return 0
      fi
      if [[ "$status" == unhealthy ]]; then
        sudo -n docker inspect --format \
          'container state={{.State.Status}} exit_code={{.State.ExitCode}} restart_count={{.RestartCount}}' "$id" >&2 || true
        return 1
      fi
    fi
    sleep 1
  done
  printf '%s did not become ready within %ss\n' "$service" "$timeout_seconds" >&2
  return 1
}

start_candidate() {
  local service="$1" expected_count="$2" previous_id previous_restart_count id
  previous_id="$(container_id "$service")"
  previous_restart_count=0
  if [[ -n "$previous_id" ]]; then
    previous_restart_count="$(sudo -n docker inspect --format '{{.RestartCount}}' "$previous_id")"
  fi
  "${compose[@]}" pull "$service" || return 1
  "${compose[@]}" up -d --no-deps --no-build "$service" || return 1
  id="$(container_id "$service")"
  candidate_restart_baseline=0
  if [[ -n "$id" && "$id" == "$previous_id" ]]; then
    candidate_restart_baseline="$previous_restart_count"
  fi
  assert_container_count "$expected_count" || return 1
  wait_service_ready "$service" 120 "$id" "$candidate_restart_baseline" || return 1
  capture_resources "candidate-${service}"
}

rollback_current_tier() {
  local tier="$1" old_slot="$2" new_slot="$3" old_service new_service old_id api_slot sandbox_slot
  old_service="$(service_for_slot "$tier" "$old_slot")"
  new_service="$(service_for_slot "$tier" "$new_slot")"
  api_slot="$(active_slot production "$API_CONFIG")"
  sandbox_slot=a
  if [[ "$sandbox_enabled" == true ]]; then
    sandbox_slot="$(active_slot sandbox "$SANDBOX_CONFIG")"
  fi
  if ! container_running "$(container_id "$old_service")"; then
    "${compose[@]}" start "$old_service" || return 1
    wait_service_ready "$old_service" 120 "" "" false || return 1
  fi
  if [[ "$tier" == production ]]; then
    api_slot="$old_slot"
  else
    sandbox_slot="$old_slot"
  fi
  apply_slots "$api_slot" "$sandbox_slot" || return 1
  if ! probe_window 10; then
    printf 'rollback could not be confirmed; both slots remain available\n' >&2
    return 1
  fi
  local tier_host="$production_host"
  [[ "$tier" == sandbox ]] && tier_host="$sandbox_host"
  if ! probe_host "$tier" "$tier_host"; then
    printf 'rollback edge check failed; both slots remain available\n' >&2
    return 1
  fi
  old_id="$(container_id "$old_service")"
  if ! probe_container_dependencies "$old_id"; then
    printf 'rollback dependency smoke failed; both slots remain available\n' >&2
    return 1
  fi
  "${compose[@]}" stop "$new_service" || return 1
  record_release rollback "$tier" "$new_slot" "$(container_revision "$(container_id "$new_service")")" \
    "$old_slot" "$(container_revision "$(container_id "$old_service")")" || return 1
  clear_pending || return 1
  printf '%s rollback confirmed\n' "$tier"
}

deploy_tier() {
  local tier="$1" inject_failure="${2:-false}" api_slot sandbox_slot old_slot new_slot old_service new_service
  local old_id old_sha new_id tier_host failed
  api_slot="$(active_slot production "$API_CONFIG")"
  sandbox_slot=a
  if [[ "$sandbox_enabled" == true ]]; then
    sandbox_slot="$(active_slot sandbox "$SANDBOX_CONFIG")"
  fi
  old_slot="$api_slot"
  [[ "$tier" == sandbox ]] && old_slot="$sandbox_slot"
  new_slot="$(other_slot "$old_slot")"
  old_service="$(service_for_slot "$tier" "$old_slot")"
  new_service="$(service_for_slot "$tier" "$new_slot")"
  old_id="$(container_id "$old_service")"
  if [[ -z "$old_id" ]] || ! container_running "$old_id"; then
    printf 'active %s slot %s is not running\n' "$tier" "$old_slot" >&2
    return 1
  fi
  old_sha="$(container_revision "$old_id")"
  write_pending "$tier" "$old_slot" "$old_sha" "$new_slot" "$AIHUB_IMAGE"

  local expected_count=3
  [[ "$sandbox_enabled" == false ]] && expected_count=2
  start_candidate "$new_service" "$expected_count" || {
    capture_resources "failed-candidate-${new_service}" || true
    "${compose[@]}" stop "$new_service" >/dev/null 2>&1 || true
    clear_pending
    return 1
  }

  if [[ "$tier" == production ]]; then
    api_slot="$new_slot"
  else
    sandbox_slot="$new_slot"
  fi
  apply_slots "$api_slot" "$sandbox_slot"
  new_id="$(container_id "$new_service")"
  tier_host="$production_host"
  [[ "$tier" == sandbox ]] && tier_host="$sandbox_host"

  failed=0
  if [[ "$inject_failure" == true ]]; then
    printf 'rehearsal: injecting a failed post-cutover smoke for %s\n' "$tier" >&2
    failed=1
  elif ! probe_window 15; then
    failed=1
  fi
  if ! probe_container_dependencies "$new_id"; then
    printf '%s candidate dependency smoke failed\n' "$tier" >&2
    failed=1
  fi
  if ! container_ready "$new_id" "$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$new_id")"; then
    failed=1
  fi
  if ! candidate_state_safe "$new_id" "$candidate_restart_baseline"; then
    failed=1
  fi
  if [[ "$failed" -eq 1 ]]; then
    capture_resources "failed-cutover-${tier}" || true
    rollback_current_tier "$tier" "$old_slot" "$new_slot" || return 1
    if [[ "$inject_failure" == true ]]; then
      printf '%s rollback rehearsal passed\n' "$tier"
      return 0
    fi
    printf '%s smoke failed; previous slot restored\n' "$tier" >&2
    return 1
  fi

  "${compose[@]}" stop "$old_service"
  if ! candidate_state_safe "$new_id" "$candidate_restart_baseline"; then
    capture_resources "failed-drain-${tier}" || true
    rollback_current_tier "$tier" "$old_slot" "$new_slot" || return 1
    printf '%s candidate restarted during drain; previous slot restored\n' "$tier" >&2
    return 1
  fi
  record_release deploy "$tier" "$old_slot" "$old_sha" "$new_slot" "$(container_revision "$new_id")"
  clear_pending
  capture_resources "committed-${tier}"
  printf '%s cutover complete old=%s new=%s\n' "$tier" "$old_sha" "$(container_revision "$new_id")"
}

preflight() {
  [[ -f .env.production && -f docker-compose.production.yml ]] || {
    printf 'production Compose files are missing\n' >&2
    return 1
  }
  [[ -d "$NGINX_STAGING" && -w "$NGINX_STAGING" ]] || {
    printf 'managed nginx staging directory is unavailable\n' >&2
    return 1
  }
  [[ -x "$NGINX_HELPER" ]] || {
    printf 'managed nginx helper is unavailable\n' >&2
    return 1
  }
  [[ ! -e "$PENDING_FILE" ]] || {
    printf 'an earlier rollout has pending state; recover it before continuing\n' >&2
    return 1
  }
  "${compose[@]}" config --quiet
  local expected_count=2
  [[ "$sandbox_enabled" == false ]] && expected_count=1
  assert_container_count "$expected_count"
  local api_slot sandbox_slot service id status
  api_slot="$(active_slot production "$API_CONFIG")"
  service="$(service_for_slot production "$api_slot")"
  id="$(container_id "$service")"
  status="$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$id")"
  container_ready "$id" "$status" || {
    printf 'active Production slot is not healthy and ready\n' >&2
    return 1
  }
  if [[ "$sandbox_enabled" == true ]]; then
    sandbox_slot="$(active_slot sandbox "$SANDBOX_CONFIG")"
    service="$(service_for_slot sandbox "$sandbox_slot")"
    id="$(container_id "$service")"
    status="$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$id")"
    container_ready "$id" "$status" || {
      printf 'active Sandbox slot is not healthy and ready\n' >&2
      return 1
    }
  fi
  probe_all
}

deploy() {
  [[ -n "$AIHUB_IMAGE" ]] || { printf 'AIHUB_IMAGE is required\n' >&2; return 1; }
  preflight
  capture_resources baseline
  compose_migrate=("${compose[@]}" --profile migration)
  "${compose_migrate[@]}" run --no-deps --rm migrate </dev/null
  if [[ "$sandbox_enabled" == true ]]; then
    compose_sandbox_migrate=("${compose[@]}" --profile migration)
    "${compose_sandbox_migrate[@]}" run --no-deps --rm migrate-sandbox </dev/null
  fi
  probe_all
  deploy_tier production
  if [[ "$sandbox_enabled" == true ]]; then
    deploy_tier sandbox
  fi
  probe_window 10
}

restore_active_after_rollback_failure() {
  local service="$1" id="$2" api_slot="$3" sandbox_slot="$4"
  if ! container_running "$id"; then
    "${compose[@]}" start "$service" || return 1
    wait_service_ready "$service" 120 "" "" false || return 1
  fi
  apply_slots "$api_slot" "$sandbox_slot" || return 1
  probe_window 10 || return 1
  probe_container_dependencies "$id"
}

rollback() {
  local tier="$1" line old_slot old_sha new_slot new_sha
  [[ "$tier" == production || "$tier" == sandbox ]] || {
    printf 'rollback tier must be production or sandbox\n' >&2
    return 1
  }
  [[ "$tier" != sandbox || "$sandbox_enabled" == true ]] || {
    printf 'Sandbox is not enabled\n' >&2
    return 1
  }
  [[ -s "$HISTORY_FILE" ]] || { printf 'no release history exists\n' >&2; return 1; }
  line="$(awk -F '\t' -v tier="$tier" '$2 == "deploy" && $3 == tier { line=$0 } END { print line }' "$HISTORY_FILE")"
  [[ -n "$line" ]] || { printf 'no successful release history for %s\n' "$tier" >&2; return 1; }
  IFS=$'\t' read -r _ _ _ old_slot old_sha new_slot new_sha <<<"$line"
  AIHUB_IMAGE="ghcr.io/aihub-ecosystem/aihub-be:${old_sha}"
  write_image_env "$AIHUB_IMAGE"
  compose=(sudo -n docker compose --env-file .env.production --env-file "$DEPLOY_ENV" -f docker-compose.production.yml --profile blue-green)
  [[ "$sandbox_enabled" == false ]] || compose+=(--profile sandbox)

  local current_api current_sandbox current_slot candidate_service active_service active_id candidate_id
  local active_api active_sandbox expected_count failed
  current_api="$(active_slot production "$API_CONFIG")"
  current_sandbox=a
  [[ "$sandbox_enabled" == false ]] || current_sandbox="$(active_slot sandbox "$SANDBOX_CONFIG")"
  current_slot="$current_api"
  [[ "$tier" == production ]] || current_slot="$current_sandbox"
  [[ "$current_slot" == "$new_slot" ]] || {
    printf 'active %s upstream does not match the latest recorded release; refusing rollback\n' "$tier" >&2
    return 1
  }
  candidate_service="$(service_for_slot "$tier" "$old_slot")"
  active_service="$(service_for_slot "$tier" "$new_slot")"
  active_id="$(container_id "$active_service")"
  if [[ -z "$active_id" ]] || ! container_running "$active_id"; then
    printf 'active %s slot %s is not running; refusing manual rollback\n' "$tier" "$new_slot" >&2
    return 1
  fi
  active_api="$current_api"
  active_sandbox="$current_sandbox"
  expected_count=3
  [[ "$sandbox_enabled" == true ]] || expected_count=2
  start_candidate "$candidate_service" "$expected_count" || {
    capture_resources "failed-rollback-${tier}" || true
    "${compose[@]}" stop "$candidate_service" >/dev/null 2>&1 || true
    return 1
  }
  candidate_id="$(container_id "$candidate_service")"
  if [[ "$tier" == production ]]; then
    current_api="$old_slot"
  else
    current_sandbox="$old_slot"
  fi
  if ! apply_slots "$current_api" "$current_sandbox"; then
    if restore_active_after_rollback_failure "$active_service" "$active_id" "$active_api" "$active_sandbox"; then
      "${compose[@]}" stop "$candidate_service" || return 1
    else
      printf 'manual rollback failed and restoring the active slot was not confirmed\n' >&2
    fi
    return 1
  fi
  failed=0
  probe_window 15 || failed=1
  probe_container_dependencies "$candidate_id" || failed=1
  if ! container_ready "$candidate_id" "$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$candidate_id")"; then
    failed=1
  fi
  candidate_state_safe "$candidate_id" "$candidate_restart_baseline" || failed=1
  if [[ "$failed" -eq 1 ]]; then
    capture_resources "failed-rollback-smoke-${tier}" || true
    if restore_active_after_rollback_failure "$active_service" "$active_id" "$active_api" "$active_sandbox"; then
      "${compose[@]}" stop "$candidate_service" || return 1
      printf 'manual rollback smoke failed; previous release remains active\n' >&2
    else
      printf 'manual rollback was not confirmed; preserve both slots for operator repair\n' >&2
    fi
    return 1
  fi
  if ! "${compose[@]}" stop "$active_service"; then
    capture_resources "failed-rollback-drain-${tier}" || true
    if restore_active_after_rollback_failure "$active_service" "$active_id" "$active_api" "$active_sandbox"; then
      "${compose[@]}" stop "$candidate_service" || return 1
    else
      printf 'manual rollback stop failed and recovery was not confirmed; preserve both slots for operator repair\n' >&2
    fi
    return 1
  fi
  if ! candidate_state_safe "$candidate_id" "$candidate_restart_baseline"; then
    capture_resources "failed-rollback-drain-${tier}" || true
    if restore_active_after_rollback_failure "$active_service" "$active_id" "$active_api" "$active_sandbox"; then
      "${compose[@]}" stop "$candidate_service" || return 1
      printf 'manual rollback candidate restarted during drain; previous release restored\n' >&2
    else
      printf 'manual rollback drain failed and recovery was not confirmed; preserve both slots for operator repair\n' >&2
    fi
    return 1
  fi
  record_release rollback "$tier" "$new_slot" "$(container_revision "$active_id")" "$old_slot" "$old_sha"
  clear_pending
  printf '%s rolled back to %s\n' "$tier" "$old_sha"
}

case "$COMMAND" in
  deploy)
    expected=2
    [[ "$sandbox_enabled" == false ]] && expected=1
    active_count="$(printf '%s\n' "$(app_container_names)" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
    if [[ "$active_count" -ne "$expected" ]]; then
      printf 'refusing rollout before migrations: found %s AIHUB application containers, expected %s active tier container(s)\n' \
        "$active_count" "$expected" >&2
      app_container_names >&2
      exit 1
    fi
    deploy
    ;;
  rollback)
    rollback "$TIER"
    ;;
  rehearse)
    [[ "$TIER" == sandbox && "$sandbox_enabled" == true ]] || {
      printf 'rollback rehearsal is limited to enabled Sandbox\n' >&2
      exit 1
    }
    [[ -n "$AIHUB_IMAGE" ]] || { printf 'AIHUB_IMAGE is required\n' >&2; exit 1; }
    preflight
    deploy_tier sandbox true
    ;;
  *)
    printf 'usage: %s deploy | rollback <production|sandbox> | rehearse sandbox\n' "$0" >&2
    exit 2
    ;;
esac
