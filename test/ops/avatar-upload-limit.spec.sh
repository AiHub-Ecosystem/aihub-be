#!/usr/bin/env bash
# Proves the operator-installed Avatar upload bound (ADR-0196, #2008) against
# the real artifact in ops/nginx/s3-wispace-avatar-upload-limit.conf.
#
# The runtime half needs nginx. It builds a synthetic stand-in for the observed
# HTTPS s3.wispace.app server, includes the artifact unmodified, and points the
# S3 upstream at a local stub, so it proves the fragment and not a copy of it.
# Without nginx the runtime half is skipped unless CI requires it explicitly.
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
artifact="$repository_root/ops/nginx/s3-wispace-avatar-upload-limit.conf"
ceil=2097152
proxy_port=18086
filer_port=18087
require_runtime="${AVATAR_UPLOAD_LIMIT_REQUIRE_RUNTIME:-0}"

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
# Both directives must be stated, not inherited: a parent that turns buffering
# off would stream a partial body to SeaweedFS, and one that intercepts errors
# would replace SeaweedFS's own 413.
grep -Fq 'proxy_request_buffering on;' "$artifact" ||
  fail "the artifact must set proxy_request_buffering on explicitly"
grep -Fq 'proxy_intercept_errors off;' "$artifact" ||
  fail "the artifact must set proxy_intercept_errors off explicitly"

if ! command -v nginx >/dev/null 2>&1; then
  [[ "$require_runtime" != 1 ]] || fail "nginx is required for the strict runtime check"
  printf 'avatar upload limit: static checks passed; runtime checks skipped (nginx not installed)\n'
  exit 0
fi
# The artifact keeps the observed upstream at 127.0.0.1:8333, so the stub must
# bind that exact port. Refuse to run if something already answers there: a
# developer's real SeaweedFS must never receive these test writes.
if curl -s -o /dev/null --max-time 1 http://127.0.0.1:8333/; then
  [[ "$require_runtime" != 1 ]] || fail "127.0.0.1:8333 is in use; refusing to run the stub"
  printf 'avatar upload limit: static checks passed; runtime checks skipped (127.0.0.1:8333 is in use)\n'
  exit 0
fi

# --- runtime half: the real artifact under a stand-in of the host server ---

# mktemp creates the root 0700, so let the worker traverse into the body dir.
chmod 0755 "$tmp"
mkdir -p "$tmp/body"
chmod 0777 "$tmp/body"

head -c "$ceil" /dev/zero >"$tmp/at-ceiling.bin"
head -c "$((ceil + 1))" /dev/zero >"$tmp/over-ceiling.bin"

# The stand-in server keeps the observed routes, each answering a distinct body
# so a shared 200 cannot hide a route that lands on the wrong handler. The
# http block deliberately inherits buffering off and error interception on: the
# artifact must override both on its own location.
cat >"$tmp/nginx.conf" <<EOF
pid $tmp/nginx.pid;
error_log $tmp/error.log;
events { worker_connections 64; }
http {
  map \$uri \$ingress_test_path {
    default other;
    /aihub-user-asset-staging/truncated truncated;
  }
  log_format ingress '\$request_method \$ingress_test_path \$status';
  access_log $tmp/ingress.log ingress;
  client_body_temp_path $tmp/body;
  proxy_request_buffering off;
  proxy_intercept_errors on;
  log_format stub '\$request_method \$request_uri host=\$host';

  server {
    listen 127.0.0.1:$proxy_port;
    server_name s3.wispace.app;
    client_max_body_size 500M;

    location ^~ /.well-known/acme-challenge/ { return 200 "route:acme"; }
    location = /healthz { return 200 "route:healthz"; }
    location /seaweed/ { return 200 "route:filer"; }
    location / { proxy_pass http://127.0.0.1:8333; }

    include $artifact;
  }

  # Stub SeaweedFS. It records the exact request target and Host it received,
  # and answers its own 413 on one key so pass-through can be checked.
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
}
EOF

nginx -t -p "$tmp/" -c "$tmp/nginx.conf" >/dev/null 2>"$tmp/nginx-t.log" ||
  { cat "$tmp/nginx-t.log" >&2; fail "the artifact does not load into the observed server"; }
nginx -p "$tmp/" -c "$tmp/nginx.conf"

base="http://127.0.0.1:$proxy_port"
status() { curl -s -o /dev/null -w '%{http_code}' --http1.1 -H 'Host: s3.wispace.app' "$@"; }
body() { curl -s --http1.1 -H 'Host: s3.wispace.app' "$@"; }
expect() {
  local want="$1" label="$2"
  shift 2
  local got
  got="$(status "$@")"
  [[ "$got" == "$want" ]] || fail "$label: expected $want, got $got"
}
expect_body() {
  local want="$1" label="$2"
  shift 2
  local got
  got="$(body "$@")"
  [[ "$got" == "$want" ]] || fail "$label: expected body '$want', got '$got'"
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
  grep -Fq "PUT /$accepted " "$tmp/upstream.log" ||
    fail "an accepted upload did not reach the S3 upstream: $accepted"
done
for rejected in \
  aihub-user-asset-staging/rejected \
  aihub-user-asset-staging/rejected-chunked \
  aihub-sandbox-user-asset-staging/rejected \
  aihub-sandbox-user-asset-staging/rejected-chunked; do
  if grep -Fq "PUT /$rejected " "$tmp/upstream.log"; then
    fail "a rejected upload reached the S3 upstream: $rejected"
  fi
done

# A declared-but-incomplete body must not be forwarded either. With buffering
# off, nginx streams the partial body; the inherited-off parent makes this
# assertion fail unless the artifact sets buffering on itself.
truncated_client() {
  exec 3<>"/dev/tcp/127.0.0.1/$proxy_port" || return 1
  printf 'PUT /aihub-user-asset-staging/truncated HTTP/1.1\r\nHost: s3.wispace.app\r\nContent-Length: 2097152\r\n\r\n' >&3 || return 1
  head -c 1048576 /dev/zero >&3 || return 1
  # Close before the declared body is complete; every setup/write/close failure
  # must fail the spec rather than turn the proof into a false pass.
  exec 3<&- 3>&- || return 1
}
truncated_client || fail "could not send and close the truncated request"
truncated_status=''
for _ in {1..50}; do
  truncated_status="$(awk '$1 == "PUT" && $2 == "truncated" { status = $3 } END { print status }' "$tmp/ingress.log" 2>/dev/null)"
  [[ -n "$truncated_status" ]] && break
  sleep 0.1
done
[[ "$truncated_status" =~ ^(400|499)$ ]] ||
  fail "the ingress did not record completion of the truncated request (status=${truncated_status:-missing})"
if grep -Fq 'PUT /aihub-user-asset-staging/truncated ' "$tmp/upstream.log"; then
  fail "an incomplete body reached the S3 upstream; proxy_request_buffering is not on"
fi

# The bound is scoped to the two staging buckets, so the rest of the shared
# host keeps its own policy and routes to its own handler.
expect 200 "another bucket keeps the server body limit" \
  -X PUT --data-binary @"$tmp/over-ceiling.bin" "$base/aihub-writing-charts/chart"
expect_body 'route:filer' "the filer location keeps its handler" "$base/seaweed/filer"
expect_body 'route:healthz' "the health location keeps its handler" "$base/healthz"
expect_body 'route:acme' "the ACME location keeps its handler" \
  "$base/.well-known/acme-challenge/token"

# Already-issued presigned grants must survive: the upstream receives the exact
# signed request target and Host, not a rewritten path.
signed_target='/aihub-user-asset-staging/orgs/o/avatar.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=test-only&X-Amz-SignedHeaders=host'
expect 200 "a signed upload still completes" \
  -X PUT --data-binary @"$tmp/at-ceiling.bin" "$base$signed_target"
grep -Fq "PUT $signed_target host=s3.wispace.app" "$tmp/upstream.log" ||
  fail "the upstream did not receive the exact signed request target and Host"

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

# Proxied responses keep SeaweedFS's own headers: an accepted upload, and a 413
# that SeaweedFS itself returned. The latter fails if the artifact inherits the
# parent's proxy_intercept_errors on, because nginx would then replace it.
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
