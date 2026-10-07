#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$repo_root/test/fixtures/ai-speaking/grading.response.json"
tmp="$(mktemp -d)"
backend_pid=""

cleanup() {
  nginx -s quit -p "$tmp/" -c "$tmp/nginx.conf" >/dev/null 2>&1 || true
  if [[ -n "$backend_pid" ]]; then
    kill "$backend_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

node -e '
  const { createServer } = require("node:http");
  const { readFileSync } = require("node:fs");
  const body = readFileSync(process.argv[1]);
  createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": body.length,
    });
    response.end(body);
  }).listen(3021, "127.0.0.1");
' "$fixture" &
backend_pid=$!

for _ in $(seq 1 50); do
  if curl --silent --fail http://127.0.0.1:3021/ >/dev/null; then
    break
  fi
  sleep 0.1
done
curl --silent --fail http://127.0.0.1:3021/ >/dev/null

# Load the actual API server block with TLS-only paths removed and high local
# ports substituted. The production locations and gzip directives stay intact.
sed \
  -e '/ssl_certificate/d' \
  -e '/include \/etc\/letsencrypt\/options-ssl-nginx.conf/d' \
  -e '/ssl_dhparam/d' \
  -e 's/listen 443 ssl;/listen 127.0.0.1:18080;/' \
  -e 's/listen 80;/listen 127.0.0.1:18081;/' \
  "$repo_root/ops/nginx/aihub-api.conf" > "$tmp/aihub-api.conf"

cat > "$tmp/nginx.conf" <<EOF
pid $tmp/nginx.pid;
error_log stderr;
events { worker_connections 64; }
http {
  # Production enables gzip globally; the API's catch-all location must still
  # keep unrelated JSON routes out of the compression scope.
  gzip on;
  gzip_types application/json;
  gzip_proxied any;
  access_log off;
  include $tmp/aihub-api.conf;
}
EOF

nginx -t -p "$tmp/" -c "$tmp/nginx.conf"
nginx -p "$tmp/" -c "$tmp/nginx.conf"

for route in grading grading-json; do
  headers="$tmp/$route.headers"
  compressed="$tmp/$route.gz"
  decoded="$tmp/$route.json"
  curl --silent --show-error -D "$headers" -o "$compressed" \
    -H 'Accept-Encoding: gzip' -X POST \
    "http://127.0.0.1:18080/v1/ielts/speaking/$route"
  grep -Eiq '^Content-Encoding: gzip' "$headers"
  grep -Eiq '^Vary:.*Accept-Encoding' "$headers"
  gzip -dc "$compressed" > "$decoded"
  cmp "$fixture" "$decoded"
  test "$(wc -c < "$compressed")" -lt "$(wc -c < "$fixture")"
done

curl --silent --show-error -D "$tmp/other.headers" -o /dev/null \
  -H 'Accept-Encoding: gzip' http://127.0.0.1:18080/health
if grep -Eiq '^Content-Encoding: gzip' "$tmp/other.headers"; then
  printf 'Unexpected gzip outside the two Speaking grading routes.\n' >&2
  exit 1
fi
