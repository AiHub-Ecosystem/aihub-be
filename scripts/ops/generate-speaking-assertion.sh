#!/usr/bin/env bash

set -euo pipefail

user_id=${1:-${AIHUB_TEST_USER_ID:-student_456}}
app_container=${AIHUB_APP_CONTAINER:-aihub-production-app-1}
private_key_file=${AIHUB_ASSERTION_PRIVATE_KEY_FILE:-/home/ngoc_anh/speaking-gateway-test-private.pem}
issuer=${AIHUB_ASSERTION_ISSUER:-https://wispace.aihubproduction.com}
kid=${AIHUB_ASSERTION_KID:-wispace-speaking-test-2026-09}

[[ -n "$user_id" ]] || { printf 'User id is required\n' >&2; exit 2; }
[[ -r "$private_key_file" ]] || { printf 'Private key file is not readable\n' >&2; exit 1; }

private_key_path=''
cleanup() {
  if [[ -n "$private_key_path" ]]; then
    sudo -n docker exec "$app_container" rm -f "$private_key_path" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

private_key_path="$(sudo -n docker exec "$app_container" mktemp /tmp/aihub-speaking-private.XXXXXX)"
cat "$private_key_file" | sudo -n docker exec -i "$app_container" sh -c "cat > '$private_key_path'"
sudo -n docker exec "$app_container" chmod 600 "$private_key_path"

sudo -n docker exec \
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
  '
