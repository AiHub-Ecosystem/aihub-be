#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'usage: %s [verify] req_<26-character-id>\n' "$0" >&2
}

verify_mode=false
if (( $# == 2 )) && [[ "$1" == verify ]]; then
  verify_mode=true
  shift
fi
if (( $# != 1 )) || [[ ! "$1" =~ ^req_[0-9A-HJKMNP-TV-Z]{26}$ ]]; then
  usage
  exit 2
fi

request_id="$1"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
app_dir="${APP_DIR:-$(cd -- "$script_dir/../../.." && pwd -P)}"
app_needle="\"request_id\":\"$request_id\""
nginx_needle="$app_needle"
app_found=false
nginx_found=false
app_incomplete=false
nginx_incomplete=false
app_verification_bad=false
nginx_verification_bad=false
app_ips=()
nginx_ips=()

if [[ "$verify_mode" == false ]]; then
  printf 'request_id=%s\n' "$request_id"
fi

json_string_field() {
  sed -nE "s/.*\"$1\":\"([^\"]*)\".*/\1/p" <<<"$2"
}

json_number_field() {
  sed -nE "s/.*\"$1\":([0-9]+).*/\1/p" <<<"$2"
}

print_app_record() {
  local line="$1" event route status outcome error_code client_ip client_ip_source
  event="$(json_string_field event "$line")"
  [[ "$event" == request_completed ]] || return 0
  route="$(json_string_field route "$line")"
  status="$(json_number_field http_status "$line")"
  outcome="$(json_string_field outcome "$line")"
  error_code="$(json_string_field error_code "$line")"
  client_ip="$(json_string_field client_ip "$line")"
  client_ip_source="$(json_string_field client_ip_source "$line")"
  if [[ ! "$route" =~ ^[A-Za-z0-9_./:{}%*-]+$ ||
    ! "$status" =~ ^[0-9]{3}$ ||
    ! "$outcome" =~ ^[a-z_]+$ ||
    ( -n "$error_code" && ! "$error_code" =~ ^[A-Z0-9_]+$ ) ]]; then
    app_incomplete=true
    return 0
  fi

  if [[ "$verify_mode" == true ]]; then
    app_ips+=("$client_ip")
    if [[ -z "$client_ip" || "$client_ip_source" != nginx ]]; then
      app_verification_bad=true
    fi
  else
    printf 'application: route=%s status=%s outcome=%s' "$route" "$status" "$outcome"
    [[ -z "$error_code" ]] || printf ' error_code=%s' "$error_code"
    printf '\n'
  fi
  app_found=true
}

print_nginx_record() {
  local line="$1" method path status client_ip
  method="$(json_string_field method "$line")"
  path="$(json_string_field path "$line")"
  status="$(json_number_field status "$line")"
  client_ip="$(json_string_field client_ip "$line")"
  path="${path%%\?*}"
  local path_pattern="^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$"
  if [[ ! "$method" =~ ^[A-Z]+$ || ! "$path" =~ $path_pattern ||
    ! "$status" =~ ^[0-9]{3}$ ]]; then
    nginx_incomplete=true
    return 0
  fi

  if [[ "$verify_mode" == true ]]; then
    nginx_ips+=("$client_ip")
    [[ -n "$client_ip" ]] || nginx_verification_bad=true
  else
    printf 'nginx: method=%s path=%s status=%s\n' "$method" "$path" "$status"
  fi
  nginx_found=true
}

consume_app_records() {
  local records="$1" line
  while IFS= read -r line; do
    [[ -n "$line" ]] && print_app_record "$line"
  done <<<"$records"
}

consume_nginx_records() {
  local records="$1" line
  while IFS= read -r line; do
    [[ -n "$line" ]] && print_nginx_record "$line"
  done <<<"$records"
}

shopt -s nullglob
snapshot_files=("$app_dir"/deploy-logs/*.log)
shopt -u nullglob
for log_file in "${snapshot_files[@]}"; do
  if records="$(grep -F -- "$app_needle" "$log_file" | grep -F -- '"event":"request_completed"')"; then
    consume_app_records "$records"
  else
    grep_status=$?
    [[ "$grep_status" == 1 ]] || app_incomplete=true
  fi
done

for service in app app-slot-b app-sandbox app-sandbox-slot-b; do
  if container_ids="$(sudo -n docker ps --all --quiet \
    --filter label=com.docker.compose.project=aihub-production \
    --filter "label=com.docker.compose.service=$service" 2>/dev/null)"; then
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] || continue
      if container_logs="$(sudo -n docker logs --timestamps "$container_id" 2>/dev/null)"; then
        if records="$(grep -F -- "$app_needle" <<<"$container_logs" | grep -F -- '"event":"request_completed"')"; then
          consume_app_records "$records"
        else
          grep_status=$?
          [[ "$grep_status" == 1 ]] || app_incomplete=true
        fi
      else
        app_incomplete=true
      fi
      unset container_logs records
    done <<<"$container_ids"
  else
    app_incomplete=true
  fi
done

if nginx_records="$(zgrep -h -F -- "$nginx_needle" /var/log/aihub-access.log* 2>/dev/null)"; then
  consume_nginx_records "$nginx_records"
else
  zgrep_status=$?
  [[ "$zgrep_status" == 1 ]] || nginx_incomplete=true
fi

result_status=0
if [[ "$app_incomplete" == true ]]; then
  [[ "$verify_mode" == true ]] || printf 'application log search incomplete; check Docker and deploy-logs access\n' >&2
  result_status=2
elif [[ "$app_found" == false ]]; then
  [[ "$verify_mode" == true ]] || printf 'application request_completed: missing (request_id=%s)\n' "$request_id" >&2
  result_status=1
fi
if [[ "$nginx_incomplete" == true ]]; then
  [[ "$verify_mode" == true ]] || printf 'AIHUB nginx log search incomplete; check zgrep and access to /var/log/aihub-access.log*\n' >&2
  result_status=2
elif [[ "$nginx_found" == false ]]; then
  [[ "$verify_mode" == true ]] || printf 'AIHUB nginx access record: missing (request_id=%s)\n' "$request_id" >&2
  [[ "$result_status" == 2 ]] || result_status=1
fi

if [[ "$verify_mode" == true ]]; then
  app_ip_count="$(printf '%s\n' "${app_ips[@]}" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')"
  nginx_ip_count="$(printf '%s\n' "${nginx_ips[@]}" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')"
  app_ip="$(printf '%s\n' "${app_ips[@]}" | sed '/^$/d' | sort -u)"
  nginx_ip="$(printf '%s\n' "${nginx_ips[@]}" | sed '/^$/d' | sort -u)"
  if [[ "$result_status" == 0 && "$app_verification_bad" == false &&
    "$nginx_verification_bad" == false && "$app_ip_count" == 1 &&
    "$nginx_ip_count" == 1 && "$app_ip" == "$nginx_ip" ]]; then
    printf 'PASS\n'
    exit 0
  fi
  printf 'FAIL\n'
  exit 1
fi

exit "$result_status"
