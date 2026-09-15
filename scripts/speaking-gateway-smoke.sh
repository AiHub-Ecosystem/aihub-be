#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /path/to/audio.wav\n' "$0" >&2
  exit 2
fi

audio_file=$1
base_url=${AIHUB_BASE_URL:-https://api.aihubproduction.com}
app_container=${AIHUB_APP_CONTAINER:-aihub-production-app-1}
api_key_file=${AIHUB_API_KEY_FILE:-/home/ngoc_anh/speaking-gateway-test-api-key}
private_key_file=${AIHUB_ASSERTION_PRIVATE_KEY_FILE:-/home/ngoc_anh/speaking-gateway-test-private.pem}
issuer=${AIHUB_ASSERTION_ISSUER:-https://wispace.aihubproduction.com}
kid=${AIHUB_ASSERTION_KID:-wispace-speaking-test-2026-09}
user_id=${AIHUB_TEST_USER_ID:-student_456}
question_id=${AIHUB_TEST_QUESTION_ID:-p1_hometown}
prompt_text=${AIHUB_TEST_PROMPT:-Do you enjoy living in your hometown?}

command -v curl >/dev/null || { printf 'curl is required\n' >&2; exit 1; }
command -v sudo >/dev/null || { printf 'sudo is required\n' >&2; exit 1; }
[[ -r "$audio_file" ]] || { printf 'Audio file is not readable: %s\n' "$audio_file" >&2; exit 1; }
[[ -r "$api_key_file" ]] || { printf 'API key file is not readable\n' >&2; exit 1; }
[[ -r "$private_key_file" ]] || { printf 'Private key file is not readable\n' >&2; exit 1; }

private_key_path=''
curl_config=''
response_file=''
api_key=''
assertion=''

cleanup() {
  if [[ -n "$private_key_path" ]]; then
    sudo -n docker exec "$app_container" rm -f "$private_key_path" >/dev/null 2>&1 || true
  fi
  rm -f "$curl_config" "$response_file"
  unset api_key assertion
}
trap cleanup EXIT

private_key_path="$(sudo -n docker exec "$app_container" mktemp /tmp/aihub-speaking-private.XXXXXX)"
cat "$private_key_file" | sudo -n docker exec -i "$app_container" sh -c "cat > '$private_key_path'"
sudo -n docker exec "$app_container" chmod 600 "$private_key_path"

assertion="$(sudo -n docker exec \
  -e ASSERTION_PRIVATE_KEY_PATH="$private_key_path" \
  -e ASSERTION_ISSUER="$issuer" \
  -e ASSERTION_KID="$kid" \
  -e ASSERTION_USER_ID="$user_id" \
  "$app_container" node --input-type=module -e '
    import { readFile } from "node:fs/promises";
    import { randomUUID } from "node:crypto";
    import { importPKCS8, SignJWT } from "jose";

    const privateKey = await importPKCS8(
      await readFile(process.env.ASSERTION_PRIVATE_KEY_PATH, "utf8"),
      "RS256",
    );
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: process.env.ASSERTION_KID })
      .setIssuer(process.env.ASSERTION_ISSUER)
      .setAudience("aihub")
      .setSubject(process.env.ASSERTION_USER_ID)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    process.stdout.write(`${assertion}\n`);
  ' )"
api_key="$(tr -d '\r\n' < "$api_key_file")"

curl_config="$(mktemp /tmp/aihub-speaking-curl.XXXXXX)"
response_file="$(mktemp /tmp/aihub-speaking-response.XXXXXX)"
chmod 600 "$curl_config" "$response_file"

printf 'url = "%s/v1/ielts/speaking/grading"\n' "${base_url%/}" > "$curl_config"
printf 'request = "POST"\n' >> "$curl_config"
printf 'header = "X-API-Key: %s"\n' "$api_key" >> "$curl_config"
printf 'header = "X-User-Assertion: %s"\n' "$assertion" >> "$curl_config"
printf 'form = "audio=@%s;type=audio/wav"\n' "$audio_file" >> "$curl_config"
printf 'form = "part=1"\n' >> "$curl_config"
printf 'form = "question_id=%s"\n' "$question_id" >> "$curl_config"
printf 'form = "prompt_text=%s"\n' "$prompt_text" >> "$curl_config"
printf 'form = "test_type=Practice"\n' >> "$curl_config"

http_status="$(curl --silent --show-error --config "$curl_config" \
  --output "$response_file" --write-out '%{http_code}')"
printf 'HTTP_STATUS=%s\n' "$http_status"

if [[ "$http_status" != 200 ]]; then
  printf 'Gateway smoke test failed (HTTP_STATUS=%s)\n' "$http_status" >&2
  exit 1
fi
