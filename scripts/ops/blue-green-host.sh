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

probe_host() {
  local tier="$1" hostname="$2" status
  status="$(curl --silent --show-error --max-time 4 -o /dev/null -w '%{http_code}' \
    "https://${hostname}/health" 2>/dev/null || printf request_error)"
  if [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
    return 0
  fi
  printf 'public /health failed for %s: %s\n' "$tier" "$status" >&2
  return 1
}

probe_all() {
  local failed=0
  probe_host production "$production_host" || failed=1
  if [[ "$sandbox_enabled" == true ]]; then
    probe_host sandbox "$sandbox_host" || failed=1
  fi
  return "$failed"
}

probe_window() {
  local seconds="$1" failed=0
  for ((attempt = 0; attempt < seconds; attempt += 1)); do
    probe_all || failed=1
    sleep 1
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
    sudo -n docker ps --filter "label=org.opencontainers.image.source=${REPOSITORY_URL}" \
      --format '{{.Names}} {{.Status}}'
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
  local service="$1" timeout_seconds="${2:-120}" id status
  for ((attempt = 0; attempt < timeout_seconds; attempt += 1)); do
    probe_all || return 1
    id="$(container_id "$service")"
    if [[ -n "$id" ]]; then
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
  local service="$1" expected_count="$2"
  "${compose[@]}" pull "$service"
  "${compose[@]}" up -d --no-deps --no-build "$service"
  assert_container_count "$expected_count"
  wait_service_ready "$service"
  capture_resources "candidate-${service}"
}

rollback_current_tier() {
  local tier="$1" old_slot="$2" new_slot="$3" old_service new_service api_slot sandbox_slot
  old_service="$(service_for_slot "$tier" "$old_slot")"
  new_service="$(service_for_slot "$tier" "$new_slot")"
  api_slot="$(active_slot production "$API_CONFIG")"
  sandbox_slot=a
  if [[ "$sandbox_enabled" == true ]]; then
    sandbox_slot="$(active_slot sandbox "$SANDBOX_CONFIG")"
  fi
  if ! container_running "$(container_id "$old_service")"; then
    "${compose[@]}" start "$old_service"
    wait_service_ready "$old_service"
  fi
  if [[ "$tier" == production ]]; then
    api_slot="$old_slot"
  else
    sandbox_slot="$old_slot"
  fi
  apply_slots "$api_slot" "$sandbox_slot"
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
  "${compose[@]}" stop "$new_service"
  record_release rollback "$tier" "$new_slot" "$(container_revision "$(container_id "$new_service")")" \
    "$old_slot" "$(container_revision "$(container_id "$old_service")")"
  clear_pending
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
  if ! container_ready "$new_id" "$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$new_id")"; then
    failed=1
  fi
  if [[ "$failed" -eq 1 ]]; then
    rollback_current_tier "$tier" "$old_slot" "$new_slot" || return 1
    if [[ "$inject_failure" == true ]]; then
      printf '%s rollback rehearsal passed\n' "$tier"
      return 0
    fi
    printf '%s smoke failed; previous slot restored\n' "$tier" >&2
    return 1
  fi

  "${compose[@]}" stop "$old_service"
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

  local current_api current_sandbox current_slot candidate_service active_service active_id
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
  "${compose[@]}" pull "$candidate_service"
  "${compose[@]}" up -d --no-deps --no-build "$candidate_service"
  wait_service_ready "$candidate_service"
  if [[ "$tier" == production ]]; then
    current_api="$old_slot"
  else
    current_sandbox="$old_slot"
  fi
  apply_slots "$current_api" "$current_sandbox"
  if ! probe_window 15; then
    if [[ "$tier" == production ]]; then current_api="$new_slot"; else current_sandbox="$new_slot"; fi
    apply_slots "$current_api" "$current_sandbox"
    probe_all || true
    printf 'manual rollback was not confirmed; both slots remain available\n' >&2
    return 1
  fi
  "${compose[@]}" stop "$active_service"
  active_id="$(container_id "$active_service")"
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
