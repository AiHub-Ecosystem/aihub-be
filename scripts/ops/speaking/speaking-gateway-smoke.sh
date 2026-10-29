#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /path/to/audio.wav\n' "$0" >&2
  exit 2
fi

audio_file=$1
base_url=${AIHUB_BASE_URL:-https://api.aihubproduction.com}
api_key_file=${AIHUB_API_KEY_FILE:?Set AIHUB_API_KEY_FILE to the API key file for AIHUB_BASE_URL}
user_identity_file=${AIHUB_USER_IDENTITY_FILE:?Set AIHUB_USER_IDENTITY_FILE to a value valid for the Organization that owns the API key}
question_id=${AIHUB_TEST_QUESTION_ID:-p1_hometown}
prompt_text=${AIHUB_TEST_PROMPT:-Do you enjoy living in your hometown?}

command -v curl >/dev/null || { printf 'curl is required\n' >&2; exit 1; }
[[ -r "$audio_file" ]] || { printf 'Audio file is not readable: %s\n' "$audio_file" >&2; exit 1; }
[[ -r "$api_key_file" ]] || { printf 'API key file is not readable\n' >&2; exit 1; }
[[ -r "$user_identity_file" ]] || { printf 'User identity file is not readable\n' >&2; exit 1; }

identity_lines=()
mapfile -t identity_lines < "$user_identity_file"
if [[ ${#identity_lines[@]} -ne 1 ]]; then
  printf 'User identity file must contain exactly one non-empty line\n' >&2
  exit 1
fi
if [[ -z ${identity_lines[0]} || ${identity_lines[0]} == *$'\r'* ]]; then
  printf 'User identity file must contain exactly one non-empty line\n' >&2
  exit 1
fi
user_identity=${identity_lines[0]}

curl_config=''
response_file=''
api_key=''

cleanup() {
  [[ -z "$curl_config" ]] || rm -f "$curl_config"
  [[ -z "$response_file" ]] || rm -f "$response_file"
  unset api_key user_identity
}
trap cleanup EXIT

api_key="$(tr -d '\r\n' < "$api_key_file")"

curl_config="$(mktemp "${TMPDIR:-/tmp}/aihub-speaking-curl.XXXXXX")"
response_file="$(mktemp "${TMPDIR:-/tmp}/aihub-speaking-response.XXXXXX")"
chmod 600 "$curl_config" "$response_file"

curl_config_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s' "$value"
}

printf 'url = "%s/v1/ielts/speaking/grading"\n' "${base_url%/}" > "$curl_config"
printf 'request = "POST"\n' >> "$curl_config"
printf 'header = "X-API-Key: %s"\n' "$api_key" >> "$curl_config"
printf 'header = "X-User-Identity: %s"\n' "$(curl_config_escape "$user_identity")" >> "$curl_config"
printf 'form = "audio=@%s;type=audio/wav"\n' "$audio_file" >> "$curl_config"
printf 'form = "part=1"\n' >> "$curl_config"
printf 'form = "question_id=%s"\n' "$question_id" >> "$curl_config"
printf 'form = "prompt_text=%s"\n' "$prompt_text" >> "$curl_config"
printf 'form = "test_type=Practice"\n' >> "$curl_config"

http_status="$(curl --silent --show-error --config "$curl_config" --output "$response_file" --write-out '%{http_code}')"
printf 'HTTP_STATUS=%s\n' "$http_status"

if [[ "$http_status" != 200 ]]; then
  printf 'Gateway smoke test failed (HTTP_STATUS=%s)\n' "$http_status" >&2
  exit 1
fi
