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
RESOURCE_LOG=

APP_DIR=${APP_DIR:?APP_DIR is required}
AIHUB_IMAGE=${AIHUB_IMAGE:-}
COMMAND=${1:-}
TIER=${2:-}
candidate_restart_baseline=0
edge_monitor_pid=""
edge_monitor_flag=""
edge_monitor_offset=0
edge_monitor_failures=""
app_container_baseline_ids=()
app_container_baseline_restarts=()

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

configured_port() {
  local key="$1" default="$2" value
  value="$(read_env "$key")"
  [[ -n "$value" ]] || value="$default"
  if ! [[ "$value" =~ ^[0-9]{1,5}$ ]] || ((10#$value < 1 || 10#$value > 65535)); then
    printf '%s must be a valid TCP port\n' "$key" >&2
    return 1
  fi
  printf '%s\n' "$((10#$value))"
}

sandbox_enabled="$(read_env AIHUB_SANDBOX_ENABLED)"
if [[ -z "$sandbox_enabled" ]]; then
  sandbox_enabled=false
fi
if [[ "$sandbox_enabled" != true && "$sandbox_enabled" != false ]]; then
  printf 'AIHUB_SANDBOX_ENABLED must be true or false\n' >&2
  exit 1
fi
sandbox_routed=false
sandbox_active_slot=a

production_slot_a_port="$(configured_port AIHUB_APP_PORT 3021)"
sandbox_slot_a_port="$(configured_port AIHUB_SANDBOX_APP_PORT 3022)"
reserved_ports=("$production_slot_a_port" 3023)
if [[ "$sandbox_enabled" == true ]]; then
  reserved_ports+=("$sandbox_slot_a_port" 3024)
fi
for ((i = 0; i < ${#reserved_ports[@]}; i += 1)); do
  for ((j = i + 1; j < ${#reserved_ports[@]}; j += 1)); do
    if [[ "${reserved_ports[i]}" == "${reserved_ports[j]}" ]]; then
      printf 'AIHUB deployment slots cannot share port %s\n' "${reserved_ports[i]}" >&2
      exit 1
    fi
  done
done

production_host="$(read_env AIHUB_PRODUCTION_HOST)"
sandbox_host="$(read_env AIHUB_SANDBOX_HOST)"
valid_hostname() {
  local hostname="$1" label
  local -a labels=()
  [[ -n "$hostname" && ${#hostname} -le 253 && "$hostname" != *[!A-Za-z0-9.-]* ]] || return 1
  [[ "$hostname" != .* && "$hostname" != *. ]] || return 1
  IFS=. read -r -a labels <<<"$hostname"
  for label in "${labels[@]}"; do
    [[ -n "$label" && ${#label} -le 63 && "$label" != -* && "$label" != *- ]] || return 1
  done
}
if [[ -z "$production_host" ]]; then
  printf 'AIHUB_PRODUCTION_HOST is required\n' >&2
  exit 1
fi
if ! valid_hostname "$production_host"; then
  printf 'AIHUB_PRODUCTION_HOST must be a DNS hostname\n' >&2
  exit 1
fi
if [[ "$sandbox_enabled" == true && -z "$sandbox_host" ]]; then
  printf 'AIHUB_SANDBOX_HOST is required when Sandbox is enabled\n' >&2
  exit 1
fi
if [[ "$sandbox_enabled" == true ]] && ! valid_hostname "$sandbox_host"; then
  printf 'AIHUB_SANDBOX_HOST must be a DNS hostname\n' >&2
  exit 1
fi
if [[ "$sandbox_enabled" == true && -z "$(read_env AIHUB_SANDBOX_ORG_IDS)" ]]; then
  printf 'AIHUB_SANDBOX_ORG_IDS is required when Sandbox is enabled\n' >&2
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

disable_sandbox_config() {
  local tmp
  tmp="$(mktemp .env.production.XXXXXX)" || return 1
  awk '!/^AIHUB_SANDBOX_ENABLED=/' .env.production >"$tmp" || {
    rm -f "$tmp"
    return 1
  }
  printf 'AIHUB_SANDBOX_ENABLED=false\n' >>"$tmp" || {
    rm -f "$tmp"
    return 1
  }
  chmod --reference=.env.production "$tmp" && mv "$tmp" .env.production || {
    rm -f "$tmp"
    return 1
  }
}

if [[ -n "$AIHUB_IMAGE" && ( "$COMMAND" == deploy || "$COMMAND" == rehearse ) ]]; then
  write_image_env "$AIHUB_IMAGE"
fi

compose=(sudo -n docker compose --env-file .env.production)
if [[ -f "$DEPLOY_ENV" ]]; then
  compose+=(--env-file "$DEPLOY_ENV")
fi
compose+=(-f docker-compose.production.yml --profile blue-green)
compose+=(--profile sandbox)

slot_for_port() {
  local tier="$1" port="$2"
  if [[ "$tier:$port" == "production:$production_slot_a_port" || \
    "$tier:$port" == "sandbox:$sandbox_slot_a_port" ]]; then
    printf a
    return 0
  fi
  case "$tier:$port" in
    production:3023 | sandbox:3024) printf b ;;
    *) printf 'unsupported %s upstream port: %s\n' "$tier" "$port" >&2; return 1 ;;
  esac
}

port_for_slot() {
  case "$1:$2" in
    production:a) printf '%s' "$production_slot_a_port" ;;
    production:b) printf 3023 ;;
    sandbox:a) printf '%s' "$sandbox_slot_a_port" ;;
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

save_service_logs() {
  local service="$1" id revision stamp log_dir
  id="$(container_id "$service")"
  [[ -n "$id" ]] || return 0
  revision="$(container_revision "$id" 2>/dev/null || true)"
  [[ "$revision" =~ ^[a-f0-9]{40}$ ]] || revision=unknown
  log_dir=deploy-logs
  if ! mkdir -p "$log_dir" || ! chmod 700 "$log_dir"; then
    return 0
  fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  sudo -n docker logs --timestamps "$id" 2>&1 \
    | tail -c 20000000 >"$log_dir/$service-${revision:0:7}-$stamp.log" || true
  find "$log_dir" -name '*.log' -mtime +30 -delete 2>/dev/null || true
}

container_running() {
  local id="$1"
  [[ "$(sudo -n docker inspect --format '{{.State.Running}}' "$id")" == true ]]
}

container_ready() {
  local id="$1" status="$2"
  [[ "$status" == healthy ]] || return 1
  sudo -n docker exec "$id" node -e '
    require("/app/scripts/ops/probe-runtime-dependencies.cjs").probeReadiness()
      .then((result) => {
        console.log(result.name + ": " + (result.ok ? "PASS" : "FAIL") + " (" + result.result + ")");
        process.exitCode = result.ok ? 0 : 1;
      })
      .catch(() => {
        console.error("readiness probe failed unexpectedly");
        process.exitCode = 1;
      });
  '
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

capture_running_app_baseline() {
  local id state status oom_killed restart_count
  local -a ids=()
  app_container_baseline_ids=()
  app_container_baseline_restarts=()
  mapfile -t ids < <(sudo -n docker ps --no-trunc --quiet --filter "label=org.opencontainers.image.source=${REPOSITORY_URL}")
  if [[ "${#ids[@]}" -eq 0 ]]; then
    printf 'no running AIHUB application containers found for rollout baseline\n' >&2
    return 1
  fi
  for id in "${ids[@]}"; do
    state="$(sudo -n docker inspect --format '{{.State.Status}} {{.State.OOMKilled}} {{.RestartCount}}' "$id")" || return 1
    read -r status oom_killed restart_count <<<"$state"
    if [[ "$status" != running || "$oom_killed" != false ]]; then
      printf 'AIHUB application container is unsafe before candidate start id=%s status=%s oom_killed=%s\n' \
        "$id" "$status" "$oom_killed" >&2
      return 1
    fi
    app_container_baseline_ids+=("$id")
    app_container_baseline_restarts+=("$restart_count")
  done
}

app_containers_safe() {
  local excluded_id="${1:-}" candidate_id="${2:-}" id current_id known_id known state status oom_killed restart_count expected_restart_count i running_ids_output
  local -a running_ids=()
  running_ids_output="$(sudo -n docker ps --no-trunc --quiet --filter "label=org.opencontainers.image.source=${REPOSITORY_URL}")" || return 1
  if [[ -n "$running_ids_output" ]]; then
    mapfile -t running_ids <<<"$running_ids_output"
  fi
  for current_id in "${running_ids[@]}"; do
    if [[ "$current_id" == "$excluded_id" ]]; then
      printf 'drained AIHUB application container is still running id=%s\n' "$current_id" >&2
      return 1
    fi
    [[ -n "$candidate_id" && "$current_id" == "$candidate_id" ]] && continue
    known=false
    for known_id in "${app_container_baseline_ids[@]}"; do
      [[ "$current_id" == "$known_id" ]] && known=true && break
    done
    if [[ "$known" != true ]]; then
      printf 'unexpected running AIHUB application container id=%s\n' "$current_id" >&2
      return 1
    fi
  done
  for ((i = 0; i < ${#app_container_baseline_ids[@]}; i += 1)); do
    id="${app_container_baseline_ids[i]}"
    expected_restart_count="${app_container_baseline_restarts[i]}"
    state="$(sudo -n docker inspect --format '{{.State.Status}} {{.State.OOMKilled}} {{.RestartCount}}' "$id")" || {
      printf 'could not inspect baseline AIHUB application container id=%s\n' "$id" >&2
      return 1
    }
    read -r status oom_killed restart_count <<<"$state"
    if [[ "$id" == "$excluded_id" ]]; then
      # A drained container is allowed to be stopped, but never to have OOMed or
      # restarted while it was finishing an in-flight request.
      if [[ "$oom_killed" != false || "$restart_count" != "$expected_restart_count" ]]; then
        printf 'drained AIHUB application container changed id=%s status=%s oom_killed=%s restart_count=%s baseline=%s\n' \
          "$id" "$status" "$oom_killed" "$restart_count" "$expected_restart_count" >&2
        return 1
      fi
      continue
    fi
    if [[ "$status" != running || "$oom_killed" != false || "$restart_count" != "$expected_restart_count" ]]; then
      printf 'baseline AIHUB application container changed id=%s status=%s oom_killed=%s restart_count=%s baseline=%s\n' \
        "$id" "$status" "$oom_killed" "$restart_count" "$expected_restart_count" >&2
      return 1
    fi
  done
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
  if [[ "$sandbox_routed" == true ]]; then
    probe_host sandbox "$sandbox_host" &
    sandbox_pid="$!"
  fi
  wait "$production_pid" || failed=1
  [[ -z "$sandbox_pid" ]] || wait "$sandbox_pid" || failed=1
  return "$failed"
}

probe_window() {
  # An optional stop file ends the window early, but only once every probe it
  # already launched has appended its sample; otherwise a shutdown could race
  # an in-flight curl and lose the failure it recorded. With a stop file, a
  # zero-second window runs until that file appears.
  local seconds="$1" stop_file="${2:-}" failed=0 attempt=0 next_at delay running_pids pid
  local -a probe_pids=() pending_pids=()
  next_at=$SECONDS
  while [[ -n "$stop_file" && ! -f "$stop_file" ]] ||
    { [[ -z "$stop_file" ]] && ((attempt < seconds)); }; do
    delay=$((next_at - SECONDS))
    if ((delay > 0)); then sleep "$delay"; fi
    if [[ -z "$stop_file" || ! -f "$stop_file" ]]; then
      probe_host production "$production_host" &
      probe_pids+=("$!")
      if [[ "$sandbox_routed" == true ]]; then
        probe_host sandbox "$sandbox_host" &
        probe_pids+=("$!")
      fi
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
    if [[ -n "$stop_file" && -f "$stop_file" && "${#probe_pids[@]}" -eq 0 ]]; then
      break
    fi
    attempt=$((attempt + 1))
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
  local api_slot="$1" sandbox_slot="$2" include_sandbox="${3:-$sandbox_routed}" api_tmp sandbox_tmp
  api_tmp="$(mktemp)"
  sandbox_tmp="$(mktemp)"
  render_config production "$api_slot" "$api_tmp"
  if [[ "$include_sandbox" == true ]]; then
    render_config sandbox "$sandbox_slot" "$sandbox_tmp"
  fi
  install -o "$(id -u)" -g "$(id -g)" -m 0644 "$api_tmp" "$NGINX_STAGING/aihub-api.conf"
  if [[ "$include_sandbox" == true ]]; then
    install -o "$(id -u)" -g "$(id -g)" -m 0644 "$sandbox_tmp" "$NGINX_STAGING/sandbox.conf"
  else
    rm -f "$NGINX_STAGING/sandbox.conf"
  fi
  rm -f "$api_tmp" "$sandbox_tmp"
  sudo -n "$NGINX_HELPER"
  [[ "$(active_slot production "$API_CONFIG")" == "$api_slot" ]]
  if [[ "$include_sandbox" == true ]]; then
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

stop_sandbox_services() {
  local service id
  for service in app-sandbox app-sandbox-slot-b; do
    id="$(container_id "$service")"
    if [[ -n "$id" ]] && container_running "$id"; then
      "${compose[@]}" stop "$service" || return 1
    fi
  done
}

load_sandbox_route_state() {
  sandbox_routed=false
  sandbox_active_slot=a
  if [[ -f "$SANDBOX_CONFIG" ]]; then
    sandbox_active_slot="$(active_slot sandbox "$SANDBOX_CONFIG")" || return 1
    sandbox_routed=true
  fi
}

reconcile_sandbox_configuration() {
  local api_slot
  if [[ "$sandbox_enabled" == true ]]; then
    load_sandbox_route_state || return 1
    if [[ "$sandbox_routed" != true ]]; then
      # With no managed route, stale direct-Compose Sandbox containers are not serving traffic.
      stop_sandbox_services || return 1
      assert_container_count 1 || return 1
    fi
    return 0
  fi

  api_slot="$(active_slot production "$API_CONFIG")" || return 1
  if [[ -f "$SANDBOX_CONFIG" ]]; then
    apply_slots "$api_slot" a false || return 1
  fi
  sandbox_routed=false
  stop_sandbox_services || return 1
  assert_container_count 1
}

capture_resources() {
  local label="$1" log="$RESOURCE_LOG" total_before idle_before total_after idle_after host_cpu_percent vcpus ids
  if [[ -z "$log" ]]; then
    log="$STATE_DIR/resources-$(date -u +%Y%m%dT%H%M%SZ).log"
    RESOURCE_LOG="$log"
  fi
  read -r total_before idle_before < <(
    awk '$1 == "cpu" { print $2 + $3 + $4 + $5 + $6 + $7 + $8 + $9, $5 + $6; exit }' /proc/stat
  ) || return 1
  sleep 1 || return 1
  read -r total_after idle_after < <(
    awk '$1 == "cpu" { print $2 + $3 + $4 + $5 + $6 + $7 + $8 + $9, $5 + $6; exit }' /proc/stat
  ) || return 1
  host_cpu_percent="$(awk -v total_before="$total_before" -v idle_before="$idle_before" \
    -v total_after="$total_after" -v idle_after="$idle_after" \
    'BEGIN { delta = total_after - total_before; if (delta <= 0) exit 1; printf "%.2f", 100 * (delta - idle_after + idle_before) / delta }')" || return 1
  vcpus="$(nproc)" || return 1
  ids="$(sudo -n docker ps -aq --filter "label=org.opencontainers.image.source=${REPOSITORY_URL}")" || return 1
  {
    printf 'label=%s at=%s\n' "$label" "$(date -u +%FT%TZ)" || return 1
    printf 'vcpus=%s\n' "$vcpus" || return 1
    printf 'host_cpu_percent=%s\n' "$host_cpu_percent" || return 1
    free -b || return 1
    sudo -n docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.MemPerc}}' || return 1
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      sudo -n docker inspect --format \
        '{{.Name}} revision={{index .Config.Labels "org.opencontainers.image.revision"}} state={{.State.Status}} oom_killed={{.State.OOMKilled}} restart_count={{.RestartCount}}' \
        "$id" || return 1
    done <<<"$ids"
  } >>"$log" || return 1
  chmod 600 "$log" || return 1
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
  local service="$1" timeout_seconds="${2:-120}" expected_id="${3:-}" expected_restart_count="${4:-}" check_edge="${5:-true}" check_app_containers="${6:-false}" id status
  for ((attempt = 0; attempt < timeout_seconds; attempt += 1)); do
    if [[ "$check_edge" == true ]]; then
      probe_all || return 1
    fi
    id="$(container_id "$service")"
    if [[ -n "$id" ]]; then
      if [[ -n "$expected_restart_count" ]]; then
        [[ "$id" == "$expected_id" ]] && candidate_state_safe "$id" "$expected_restart_count" || return 1
        if [[ "$check_app_containers" == true ]]; then
          app_containers_safe "" "$expected_id" || return 1
        fi
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

# Sampling every enabled hostname for the whole of some slow step (an image
# pull, a drain). start/stop own the lifecycle so no caller has to reap a
# monitor by hand; edge_monitor_failures then names the tiers that failed.
edge_monitor_start() {
  local log="$STATE_DIR/edge-probes.tsv"
  edge_monitor_pid=""
  edge_monitor_flag="$STATE_DIR/edge-monitor.stop"
  edge_monitor_failures=""
  edge_monitor_offset=0
  [[ -f "$log" ]] && edge_monitor_offset="$(stat -c %s "$log")"
  rm -f "$edge_monitor_flag"
  probe_window "$1" "$edge_monitor_flag" &
  edge_monitor_pid="$!"
}

edge_monitor_stop() {
  [[ -n "$edge_monitor_pid" ]] || return 0
  : >"$edge_monitor_flag"
  wait "$edge_monitor_pid" 2>/dev/null || true
  rm -f "$edge_monitor_flag"
  edge_monitor_pid=""
  edge_monitor_failures="$(failed_edge_tiers "$edge_monitor_offset")"
}

start_candidate() {
  local service="$1" expected_count="$2" check_edge="${3:-true}" status=0
  # Only monitor where the active edge is expected to be healthy: the manual
  # rollback starts its candidate while the public edge is known to be failing.
  if [[ "$check_edge" == true ]]; then
    edge_monitor_start 0
  else
    edge_monitor_failures=""
  fi
  prepare_candidate "$service" "$expected_count" "$check_edge" || status=$?
  edge_monitor_stop
  if [[ "$status" -eq 0 && -n "$edge_monitor_failures" ]]; then
    printf 'public edge probe failed while %s started: %s\n' "$service" "$edge_monitor_failures" >&2
    status=1
  fi
  return "$status"
}

prepare_candidate() {
  local service="$1" expected_count="$2" check_edge="$3" previous_id previous_restart_count id
  previous_id="$(container_id "$service")"
  previous_restart_count=0
  if [[ -n "$previous_id" ]]; then
    previous_restart_count="$(sudo -n docker inspect --format '{{.RestartCount}}' "$previous_id")"
  fi
  capture_running_app_baseline || return 1
  save_service_logs "$service"
  "${compose[@]}" pull "$service" || return 1
  assert_container_count "$((expected_count - 1))" || return 1
  "${compose[@]}" up -d --no-deps --no-build "$service" || return 1
  id="$(container_id "$service")"
  candidate_restart_baseline=0
  if [[ -n "$id" && "$id" == "$previous_id" ]]; then
    candidate_restart_baseline="$previous_restart_count"
  fi
  assert_container_count "$expected_count" || return 1
  wait_service_ready "$service" 120 "$id" "$candidate_restart_baseline" "$check_edge" true || return 1
  capture_resources "candidate-${service}"
}

drain_old_slot() {
  local service="$1" status=0
  # Compose waits out stop_grace_period (150s) on in-flight work, so the edge
  # monitor has to span the drain and record_release has to see its samples.
  edge_monitor_start 0
  "${compose[@]}" stop "$service" || status=$?
  edge_monitor_stop
  return "$status"
}

rollback_current_tier() {
  local tier="$1" old_slot="$2" new_slot="$3" old_service new_service old_id new_id api_slot sandbox_slot
  old_service="$(service_for_slot "$tier" "$old_slot")"
  new_service="$(service_for_slot "$tier" "$new_slot")"
  api_slot="$(active_slot production "$API_CONFIG")"
  sandbox_slot=a
  if [[ "$sandbox_routed" == true ]]; then
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
  new_id="$(container_id "$new_service")"
  if ! app_containers_safe "" "$new_id"; then
    printf 'rollback could not be confirmed; an application container restarted or OOMed\n' >&2
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
  local old_id old_sha new_id failed drain_status
  api_slot="$(active_slot production "$API_CONFIG")"
  sandbox_slot=a
  if [[ "$sandbox_routed" == true ]]; then
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
  [[ "$sandbox_routed" == false ]] && expected_count=2
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
  failed=0
  probe_window 15 || failed=1
  if [[ "$inject_failure" == true ]]; then
    printf 'rehearsal: injecting a failed post-cutover smoke for %s\n' "$tier" >&2
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
  if ! app_containers_safe "" "$new_id"; then
    failed=1
  fi
  capture_resources "post-cutover-${tier}" || failed=1
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

  drain_status=0
  drain_old_slot "$old_service" || drain_status=$?
  resource_status=0
  capture_resources "drained-${tier}" || resource_status=1
  if [[ "$drain_status" -ne 0 || "$resource_status" -ne 0 || -n "$edge_monitor_failures" ]] ||
    ! candidate_state_safe "$new_id" "$candidate_restart_baseline" ||
    ! app_containers_safe "$old_id" "$new_id"; then
    capture_resources "failed-drain-${tier}" || true
    rollback_current_tier "$tier" "$old_slot" "$new_slot" || return 1
    printf '%s failed while the old slot drained; previous slot restored\n' "$tier" >&2
    return 1
  fi
  record_release deploy "$tier" "$old_slot" "$old_sha" "$new_slot" "$(container_revision "$new_id")"
  clear_pending
  capture_resources "committed-${tier}"
  printf '%s cutover complete old=%s new=%s\n' "$tier" "$old_sha" "$(container_revision "$new_id")"
}

cleanup_sandbox_bootstrap() {
  local api_slot="$1" service="$2"
  if ! apply_slots "$api_slot" a false; then
    if ! load_sandbox_route_state || [[ "$sandbox_routed" == true ]]; then
      printf 'Sandbox bootstrap route could not be removed; preserve its container for operator repair\n' >&2
      return 1
    fi
  fi
  sandbox_routed=false
  "${compose[@]}" stop "$service" || return 1
  clear_pending
}

bootstrap_sandbox() {
  local service=app-sandbox api_slot id failed=0
  api_slot="$(active_slot production "$API_CONFIG")"
  write_pending sandbox disabled disabled a "$AIHUB_IMAGE"
  if ! start_candidate "$service" 2 false; then
    capture_resources failed-sandbox-bootstrap || true
    "${compose[@]}" stop "$service" >/dev/null 2>&1 || true
    clear_pending
    return 1
  fi
  id="$(container_id "$service")"
  if ! probe_container_dependencies "$id"; then
    cleanup_sandbox_bootstrap "$api_slot" "$service" || return 1
    printf 'Sandbox bootstrap dependency smoke failed\n' >&2
    return 1
  fi
  if ! apply_slots "$api_slot" a true; then
    load_sandbox_route_state || return 1
    if [[ "$sandbox_routed" == true ]]; then
      cleanup_sandbox_bootstrap "$api_slot" "$service" || return 1
    else
      "${compose[@]}" stop "$service" || return 1
      clear_pending
    fi
    return 1
  fi
  sandbox_routed=true

  probe_window 15 || failed=1
  candidate_state_safe "$id" "$candidate_restart_baseline" || failed=1
  app_containers_safe "" "$id" || failed=1
  capture_resources post-cutover-sandbox-bootstrap || failed=1
  if [[ "$failed" -eq 1 ]]; then
    capture_resources failed-sandbox-bootstrap || true
    cleanup_sandbox_bootstrap "$api_slot" "$service" || return 1
    printf 'Sandbox bootstrap smoke failed; its route and container were removed\n' >&2
    return 1
  fi

  record_release deploy sandbox disabled disabled a "$(container_revision "$id")"
  clear_pending
  printf 'Sandbox enabled active=%s\n' "$(container_revision "$id")"
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
  check_vault_agent
  local expected_count=2
  [[ "$sandbox_routed" == false ]] && expected_count=1
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
  if [[ "$sandbox_routed" == true ]]; then
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

check_vault_agent() {
  local id running logs
  id="$(container_id vault-agent)"
  if [[ -z "$id" ]]; then
    printf 'vault-agent container is missing\n' >&2
    return 1
  fi
  running="$(sudo -n docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null || true)"
  if [[ "$running" != true ]]; then
    printf 'vault-agent is not running\n' >&2
    return 1
  fi
  if ! sudo -n docker exec "$id" sh -ec '
    test -s /run/secrets/aihub/runtime-secrets.json
    test -s /run/secrets/aihub/auth-mfa-secrets.json
    test -s /run/secrets/aihub/connection-secrets.json
    wget -q -T 2 -O /dev/null "http://127.0.0.1:8220/agent/v1/metrics?format=prometheus"
  '; then
    printf 'vault-agent bundles or metrics endpoint failed checks\n' >&2
    return 1
  fi
  logs="$("${compose[@]}" logs --no-color --since 1h vault-agent 2>&1 || true)"
  case "$logs" in
    *"authentication successful"* | *"renewed auth token"*) ;;
    *)
      printf 'vault-agent has not authenticated in the last hour\n' >&2
      printf '%s\n' "$logs" | tail -100 >&2
      return 1
      ;;
  esac
}

failed_edge_tiers() {
  local log="$STATE_DIR/edge-probes.tsv" offset="$1" tier host
  local -a tiers=()
  mapfile -t tiers < <(
    tail -c "+$((offset + 1))" "$log" 2>/dev/null \
      | awk -F '\t' '$4 !~ /^2[0-9][0-9]$/ { print $3 }' | sort -u
  )
  if [[ "${#tiers[@]}" -eq 0 ]]; then
    # No attributable sample, so probe each host once rather than leave a tier live.
    for tier in production sandbox; do
      if [[ "$tier" == sandbox && "$sandbox_routed" != true ]]; then
        continue
      fi
      host="$production_host"
      if [[ "$tier" == sandbox ]]; then
        host="$sandbox_host"
      fi
      probe_host "$tier" "$host" || tiers+=("$tier")
    done
  fi
  [[ "${#tiers[@]}" -eq 0 ]] || printf '%s\n' "${tiers[@]}"
}

final_edge_window() {
  local seconds="$1" log="$STATE_DIR/edge-probes.tsv" offset=0 tier
  local -a failing_tiers=()
  [[ -f "$log" ]] && offset="$(stat -c %s "$log")"
  probe_window "$seconds" && return 0
  # Both tiers already stopped their old services, so a failure here has to
  # restore the recorded release instead of exiting with the outage live.
  mapfile -t failing_tiers < <(failed_edge_tiers "$offset")
  for tier in "${failing_tiers[@]}"; do
    printf 'final edge probe failed for %s; rolling that tier back\n' "$tier" >&2
    rollback "$tier" || printf '%s rollback was not confirmed; preserve both slots for operator repair\n' "$tier" >&2
  done
  return 1
}

deploy() {
  [[ -n "$AIHUB_IMAGE" ]] || { printf 'AIHUB_IMAGE is required\n' >&2; return 1; }
  preflight
  capture_resources baseline
  # Baseline before the migrations: start_candidate rebaselines per tier, so a
  # restart or OOM caused here would otherwise become the accepted baseline.
  capture_running_app_baseline || return 1
  compose_migrate=("${compose[@]}" --profile migration)
  edge_monitor_start 0
  migration_status=0
  "${compose_migrate[@]}" run --no-deps --rm migrate </dev/null || migration_status=$?
  if [[ "$sandbox_enabled" == true && "$migration_status" -eq 0 ]]; then
    compose_sandbox_migrate=("${compose[@]}" --profile migration)
    "${compose_sandbox_migrate[@]}" run --no-deps --rm migrate-sandbox </dev/null || migration_status=$?
  fi
  edge_monitor_stop
  capture_resources after-migrations || migration_status=1
  if [[ "$migration_status" -ne 0 ]]; then
    capture_resources failed-migration || true
    printf 'a migration failed\n' >&2
    return 1
  fi
  if [[ -n "$edge_monitor_failures" ]]; then
    capture_resources failed-migration || true
    printf 'public edge probe failed while migrations ran: %s\n' "$edge_monitor_failures" >&2
    return 1
  fi
  if ! app_containers_safe "" ""; then
    capture_resources failed-migration || true
    printf 'an application container restarted or OOMed while migrations ran\n' >&2
    return 1
  fi
  probe_all
  deploy_tier production
  if [[ "$sandbox_enabled" == true ]]; then
    if [[ "$sandbox_routed" == true ]]; then
      deploy_tier sandbox
    else
      bootstrap_sandbox
    fi
  fi
  final_edge_window 10
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

rollback_sandbox_to_disabled() {
  local slot="$1" sha="$2" api_slot service id
  load_sandbox_route_state || return 1
  [[ "$sandbox_routed" == true && "$sandbox_active_slot" == "$slot" ]] || {
    printf 'Sandbox route does not match the recorded enabled release; refusing rollback\n' >&2
    return 1
  }
  service="$(service_for_slot sandbox "$slot")"
  id="$(container_id "$service")"
  if [[ -z "$id" ]] || ! container_running "$id"; then
    printf 'active Sandbox slot %s is not running; refusing rollback\n' "$slot" >&2
    return 1
  fi
  api_slot="$(active_slot production "$API_CONFIG")"
  write_pending sandbox "$slot" "$sha" disabled disabled
  apply_slots "$api_slot" "$slot" false || return 1
  sandbox_routed=false
  if ! probe_window 10; then
    if ! container_running "$id"; then
      "${compose[@]}" start "$service" || return 1
      wait_service_ready "$service" 120 "" "" false || return 1
    fi
    apply_slots "$api_slot" "$slot" true || return 1
    sandbox_routed=true
    if probe_window 10; then
      clear_pending
    fi
    printf 'Production probe failed; Sandbox route was restored\n' >&2
    return 1
  fi
  if ! stop_sandbox_services; then
    if ! container_running "$id"; then
      "${compose[@]}" start "$service" || return 1
      wait_service_ready "$service" 120 "" "" false || return 1
    fi
    apply_slots "$api_slot" "$slot" true || return 1
    sandbox_routed=true
    clear_pending
    printf 'Sandbox service could not be stopped; its route was restored\n' >&2
    return 1
  fi
  disable_sandbox_config || return 1
  assert_container_count 1 || return 1
  record_release rollback sandbox "$slot" "$sha" disabled disabled
  clear_pending
  printf 'Sandbox disabled rollback confirmed\n'
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
  load_sandbox_route_state || return 1
  [[ -s "$HISTORY_FILE" ]] || { printf 'no release history exists\n' >&2; return 1; }
  line="$(awk -F '\t' -v tier="$tier" '$2 == "deploy" && $3 == tier { line=$0 } END { print line }' "$HISTORY_FILE")"
  [[ -n "$line" ]] || { printf 'no successful release history for %s\n' "$tier" >&2; return 1; }
  check_vault_agent
  IFS=$'\t' read -r _ _ _ old_slot old_sha new_slot new_sha <<<"$line"
  if [[ "$tier" == sandbox && "$old_slot" == disabled ]]; then
    rollback_sandbox_to_disabled "$new_slot" "$new_sha"
    return $?
  fi
  AIHUB_IMAGE="ghcr.io/aihub-ecosystem/aihub-be:${old_sha}"
  write_image_env "$AIHUB_IMAGE"
  compose=(sudo -n docker compose --env-file .env.production --env-file "$DEPLOY_ENV" -f docker-compose.production.yml --profile blue-green)
  compose+=(--profile sandbox)

  local current_api current_sandbox current_slot candidate_service active_service active_id candidate_id
  local active_api active_sandbox expected_count failed
  current_api="$(active_slot production "$API_CONFIG")"
  current_sandbox=a
  if [[ "$sandbox_routed" == true ]]; then
    current_sandbox="$(active_slot sandbox "$SANDBOX_CONFIG")"
  fi
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
  [[ "$sandbox_routed" == true ]] || expected_count=2
  # nginx still points at the slot being replaced, so probing the edge here would
  # only re-confirm the failure that triggered this rollback; it is validated
  # after apply_slots instead.
  start_candidate "$candidate_service" "$expected_count" false || {
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
  app_containers_safe "" "$candidate_id" || failed=1
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
  if ! drain_old_slot "$active_service"; then
    capture_resources "failed-rollback-drain-${tier}" || true
    if restore_active_after_rollback_failure "$active_service" "$active_id" "$active_api" "$active_sandbox"; then
      "${compose[@]}" stop "$candidate_service" || return 1
    else
      printf 'manual rollback stop failed and recovery was not confirmed; preserve both slots for operator repair\n' >&2
    fi
    return 1
  fi
  if [[ -n "$edge_monitor_failures" ]] || ! candidate_state_safe "$candidate_id" "$candidate_restart_baseline" ||
    ! app_containers_safe "$active_id" "$candidate_id"; then
    capture_resources "failed-rollback-drain-${tier}" || true
    if restore_active_after_rollback_failure "$active_service" "$active_id" "$active_api" "$active_sandbox"; then
      "${compose[@]}" stop "$candidate_service" || return 1
      printf 'manual rollback failed while the active slot drained; previous release restored\n' >&2
    else
      printf 'manual rollback drain failed and recovery was not confirmed; preserve both slots for operator repair\n' >&2
    fi
    return 1
  fi
  record_release rollback "$tier" "$new_slot" "$(container_revision "$active_id")" "$old_slot" "$old_sha"
  clear_pending
  capture_resources "rollback-confirmed-${tier}" || true
  printf '%s rolled back to %s\n' "$tier" "$old_sha"
}

status_tier() {
  local tier="$1" slot service id sha config="$API_CONFIG"
  [[ "$tier" != sandbox ]] || config="$SANDBOX_CONFIG"
  if ! slot="$(active_slot "$tier" "$config")"; then
    printf '%s active_slot=unknown sha=unavailable\n' "$tier"
    return 0
  fi
  service="$(service_for_slot "$tier" "$slot")"
  id="$(container_id "$service" 2>/dev/null || true)"
  if [[ -z "$id" ]]; then
    printf '%s active_slot=%s sha=unavailable service=%s\n' "$tier" "$slot" "$service"
    return 0
  fi
  sha="$(container_revision "$id" 2>/dev/null || true)"
  [[ "$sha" =~ ^[a-f0-9]{40}$ ]] || sha=unknown
  printf '%s active_slot=%s sha=%s service=%s\n' "$tier" "$slot" "$sha" "$service"
}

status() {
  status_tier production
  if [[ "$sandbox_routed" == true ]]; then
    status_tier sandbox
  elif [[ "$sandbox_enabled" == true ]]; then
    printf 'sandbox enabled but not routed\n'
  else
    printf 'sandbox disabled\n'
  fi
  if [[ -s "$PENDING_FILE" ]]; then
    printf 'pending=%s\n' "$(tr '\t' ' ' <"$PENDING_FILE")"
  fi
}

case "$COMMAND" in
  deploy)
    reconcile_sandbox_configuration || exit 1
    expected=2
    [[ "$sandbox_routed" == false ]] && expected=1
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
  status)
    load_sandbox_route_state || exit 1
    status
    ;;
  rehearse)
    load_sandbox_route_state || exit 1
    [[ "$TIER" == sandbox && "$sandbox_enabled" == true && "$sandbox_routed" == true ]] || {
      printf 'rollback rehearsal is limited to enabled Sandbox\n' >&2
      exit 1
    }
    [[ -n "$AIHUB_IMAGE" ]] || { printf 'AIHUB_IMAGE is required\n' >&2; exit 1; }
    preflight
    deploy_tier sandbox true
    ;;
  *)
    printf 'usage: %s deploy | rollback <production|sandbox> | rehearse sandbox | status\n' "$0" >&2
    exit 2
    ;;
esac
