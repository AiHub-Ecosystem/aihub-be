#!/usr/bin/env bash
# Proves the operator-installed Avatar upload bound (ADR-0196, #2008) against
# the real artifact in ops/nginx/s3-wispace-avatar-upload-limit.conf.
#
# The runtime half needs nginx. It builds a synthetic stand-in for the observed
# HTTPS s3.wispace.app server, includes the artifact unmodified, and points the
# S3 upstream at a local stub, so it proves the fragment and not a copy of it.
# Without nginx the runtime half is skipped and only the static half runs.
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
artifact="$repository_root/ops/nginx/s3-wispace-avatar-upload-limit.conf"
ceil=2097152
proxy_port=18086
filer_port=18087

tmp="$(mktemp -d)"

cleanup() {
  nginx -s quit -p "$tmp/" -c "$tmp/nginx.conf" >/dev/null 2>&1 || true
  rm -rf -- "$tmp"
}
trap cleanup EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

# --- static half: the artifact states the agreed policy -------------------

grep -Fq "client_max_body_size $ceil;" "$artifact" ||
  fail "the artifact must bound the body at exactly $ceil bytes"
if grep -Eq 'client_max_body_size[[:space:]]+(0|[0-9]+[kKmMgG])' "$artifact"; then
  fail "the artifact must use the byte ceiling, not a rounded size"
fi
for bucket in aihub-user-asset-staging aihub-sandbox-user-asset-staging; do
  grep -Fq "$bucket" "$artifact" || fail "the artifact must cover $bucket"
done
grep -Fq 'proxy_pass http://127.0.0.1:8333;' "$artifact" ||
  fail "the artifact must keep the observed S3 upstream and path form"
for header in 'Host $host' 'X-Real-IP $remote_addr' \
  'X-Forwarded-For $proxy_add_x_forwarded_for' 'X-Forwarded-Proto $scheme'; do
  grep -Fq "proxy_set_header $header;" "$artifact" ||
    fail "the artifact must forward the observed $header"
done
grep -Fq 'proxy_connect_timeout 300s;' "$artifact" ||
  fail "the artifact must keep the observed connect timeout"
grep -Fq 'proxy_read_timeout 300s;' "$artifact" ||
  fail "the artifact must keep the observed read timeout"
# Buffering the request before contacting the upstream is what keeps a
# rejected body out of SeaweedFS; intercepting upstream errors would rewrite
# SeaweedFS's own 413 responses.
if grep -Eq '^[[:space:]]*proxy_request_buffering[[:space:]]+off' "$artifact"; then
  fail "the artifact must keep request buffering so rejects never reach S3"
fi
if grep -Eq '^[[:space:]]*proxy_intercept_errors[[:space:]]+on' "$artifact"; then
  fail "the artifact must not rewrite a 413 that SeaweedFS itself returns"
fi
grep -Fq 'add_header Access-Control-Allow-Origin $http_origin always;' "$artifact" ||
  fail "the ingress-generated 413 must be readable from an allowed origin"
grep -Fq 'add_header Vary Origin always;' "$artifact" ||
  fail "the ingress-generated 413 must vary on Origin"
for origin in 'aihubproduction\.com' 'www\.aihubproduction\.com' 'sandbox\.aihubproduction\.com'; do
  grep -Fq "$origin" "$artifact" || fail "the artifact must allow $origin"
done
if grep -Eq 'Access-Control-Allow-Origin[[:space:]]+"?\*' "$artifact"; then
  fail "the artifact must not widen the 413 to a wildcard origin"
fi
grep -Fq 'error_page 413 = @aihub_avatar_upload_too_large;' "$artifact" ||
  fail "the artifact must serve its own 413 for rejected bodies"

if ! command -v nginx >/dev/null 2>&1; then
  printf 'avatar upload limit: static checks passed; runtime checks skipped (nginx not installed)\n'
  exit 0
fi
# The artifact keeps the observed upstream at 127.0.0.1:8333, so the stub must
# bind that exact port. Refuse to run if something already answers there: a
# developer's real SeaweedFS must never receive these test writes.
if curl -s -o /dev/null --max-time 1 http://127.0.0.1:8333/; then
  printf 'avatar upload limit: static checks passed; runtime checks skipped (127.0.0.1:8333 is in use)\n'
  exit 0
fi

# --- runtime half: the real artifact under a stand-in of the host server ---

# nginx workers spool bodies past client_body_buffer_size here; the directory
# must exist and be writable by the worker user.
# mktemp creates the root 0700, so let the worker traverse into the body dir.
chmod 0755 "$tmp"
mkdir -p "$tmp/body"
chmod 0777 "$tmp/body"

head -c "$ceil" /dev/zero >"$tmp/at-ceiling.bin"
head -c "$((ceil + 1))" /dev/zero >"$tmp/over-ceiling.bin"

cat >"$tmp/nginx.conf" <<EOF
pid $tmp/nginx.pid;
error_log $tmp/error.log;
events { worker_connections 64; }
http {
  access_log off;
  client_body_temp_path $tmp/body;
  server {
    listen 127.0.0.1:$proxy_port;
    server_name s3.wispace.app;
    client_max_body_size 500M;

    location ^~ /.well-known/acme-challenge/ { return 200 "acme"; }
    location = /healthz { return 200 "ok"; }
    location /seaweed/ {
      proxy_pass http://127.0.0.1:$filer_port;
    }
    location / {
      proxy_pass http://127.0.0.1:8333;
      proxy_set_header Host \$host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_connect_timeout 300s;
      proxy_read_timeout 300s;
    }

    include $artifact;
  }

  # Stub SeaweedFS: logs every request that actually reaches S3, so a
  # rejected body can be shown never to arrive.
  log_format stub '\$request_method \$uri';
  server {
    listen 127.0.0.1:8333;
    client_max_body_size 0;
    access_log $tmp/upstream.log stub;
    location = /aihub-user-asset-staging/upstream-413 {
      add_header Access-Control-Allow-Origin "https://s3-upstream.example" always;
      return 413 "seaweedfs-own-413";
    }
    location / {
      add_header Access-Control-Allow-Origin "https://s3-upstream.example" always;
      return 200 "upstream";
    }
  }
  server {
    listen 127.0.0.1:$filer_port;
    client_max_body_size 0;
    location / { return 200 "filer"; }
  }
}
EOF

nginx -t -p "$tmp/" -c "$tmp/nginx.conf" >/dev/null 2>"$tmp/nginx-t.log" ||
  { cat "$tmp/nginx-t.log" >&2; fail "the artifact does not load into the observed server"; }
nginx -p "$tmp/" -c "$tmp/nginx.conf"

base="http://127.0.0.1:$proxy_port"
status() { curl -s -o /dev/null -w '%{http_code}' --http1.1 -H 'Host: s3.wispace.app' "$@"; }
expect() {
  local want="$1" label="$2"
  shift 2
  local got
  got="$(status "$@")"
  [[ "$got" == "$want" ]] || fail "$label: expected $want, got $got"
}

# Each case uses its own object key so the upstream log proves which requests
# arrived. A rejected body must never reach S3: the stub answers 200, so a 413
# here was produced by nginx while receiving the body.
for bucket in aihub-user-asset-staging aihub-sandbox-user-asset-staging; do
  expect 200 "$bucket accepts the exact ceiling" \
    -X PUT --data-binary @"$tmp/at-ceiling.bin" "$base/$bucket/accepted"
  expect 413 "$bucket rejects one byte over the ceiling" \
    -X PUT --data-binary @"$tmp/over-ceiling.bin" "$base/$bucket/rejected"
  expect 413 "$bucket rejects one byte over a chunked body" \
    -X PUT -H 'Transfer-Encoding: chunked' \
    --data-binary @"$tmp/over-ceiling.bin" "$base/$bucket/rejected-chunked"
done
expect 200 "a chunked body at the ceiling is forwarded" \
  -X PUT -H 'Transfer-Encoding: chunked' \
  --data-binary @"$tmp/at-ceiling.bin" "$base/aihub-user-asset-staging/accepted-chunked"

# Only complete, accepted bodies reached the upstream.
for accepted in \
  aihub-user-asset-staging/accepted \
  aihub-user-asset-staging/accepted-chunked \
  aihub-sandbox-user-asset-staging/accepted; do
  grep -Fq "PUT /$accepted" "$tmp/upstream.log" ||
    fail "an accepted upload did not reach the S3 upstream: $accepted"
done
for rejected in \
  aihub-user-asset-staging/rejected \
  aihub-user-asset-staging/rejected-chunked \
  aihub-sandbox-user-asset-staging/rejected \
  aihub-sandbox-user-asset-staging/rejected-chunked; do
  if grep -Fq "PUT /$rejected" "$tmp/upstream.log"; then
    fail "a rejected upload reached the S3 upstream: $rejected"
  fi
done

# The bound is scoped to the two staging buckets, so the rest of the shared
# host keeps its own policy.
expect 200 "another bucket keeps the server body limit" \
  -X PUT --data-binary @"$tmp/over-ceiling.bin" "$base/aihub-writing-charts/chart"
expect 200 "the filer location is unchanged" "$base/seaweed/filer"
expect 200 "the health location is unchanged" "$base/healthz"
expect 200 "the ACME location is unchanged" "$base/.well-known/acme-challenge/t"

# Already-issued presigned grants must survive: path, query, and Host.
signed="$base/aihub-user-asset-staging/orgs/o/avatar.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&X-Amz-SignedHeaders=host"
expect 200 "a signed upload still completes" -X PUT --data-binary @"$tmp/at-ceiling.bin" "$signed"

# The browser must be able to read the 413, and only from the deployed origins.
headers() { curl -s -D - -o /dev/null --http1.1 -H 'Host: s3.wispace.app' "$@" | tr -d '\r'; }
for origin in https://aihubproduction.com https://www.aihubproduction.com \
  https://sandbox.aihubproduction.com; do
  headers -X PUT -H "Origin: $origin" --data-binary @"$tmp/over-ceiling.bin" \
    "$base/aihub-user-asset-staging/orgs/o/avatar.webp" >"$tmp/413.headers"
  grep -Fqi "access-control-allow-origin: $origin" "$tmp/413.headers" ||
    fail "the 413 must be readable from $origin"
  grep -Fqi 'vary: origin' "$tmp/413.headers" ||
    fail "the 413 must vary on Origin for $origin"
done
headers -X PUT -H 'Origin: https://evil.example' \
  --data-binary @"$tmp/over-ceiling.bin" \
  "$base/aihub-user-asset-staging/orgs/o/avatar.webp" >"$tmp/413.headers"
if grep -Fqi 'access-control-allow-origin' "$tmp/413.headers"; then
  fail "the 413 must not answer an origin outside the deployed Customer Web origins"
fi

# Proxied responses keep SeaweedFS''s own headers: an accepted upload, and a
# 413 that SeaweedFS itself returned, must not be rewritten by the ingress.
headers -X PUT --data-binary @"$tmp/at-ceiling.bin" \
  "$base/aihub-user-asset-staging/orgs/o/avatar.webp" >"$tmp/200.headers"
grep -Fqi 'access-control-allow-origin: https://s3-upstream.example' "$tmp/200.headers" ||
  fail "a proxied response must keep the CORS headers SeaweedFS returned"

headers -X PUT --data-binary @"$tmp/at-ceiling.bin" \
  "$base/aihub-user-asset-staging/upstream-413" >"$tmp/upstream-413.headers"
grep -Fqi 'access-control-allow-origin: https://s3-upstream.example' "$tmp/upstream-413.headers" ||
  fail "an upstream 413 must keep the CORS headers SeaweedFS returned"
if grep -Fqi 'vary: origin' "$tmp/upstream-413.headers"; then
  fail "an upstream 413 must not gain the ingress Vary header"
fi

printf 'Avatar upload ingress checks passed\n'
