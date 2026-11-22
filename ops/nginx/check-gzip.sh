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

for config in aihub-api.conf sandbox.conf; do
  if ! grep -Fq 'proxy_set_header X-Forwarded-Host $host;' "$repo_root/ops/nginx/$config"; then
    printf '%s must overwrite X-Forwarded-Host from the routed Host.\n' "$config" >&2
    exit 1
  fi
  if [[ "$(grep -Fc 'access_log /var/log/aihub-access.log aihub_access;' "$repo_root/ops/nginx/$config")" -ne 2 ]]; then
    printf '%s must route both server blocks to the AIHUB access log.\n' "$config" >&2
    exit 1
  fi
done

sed "s#/var/log/aihub-access.log#$tmp/aihub-access.log#g" \
  "$repo_root/ops/nginx/aihub-access-logrotate" > "$tmp/aihub-access-logrotate"
grep -Fq 'create 0640 root adm' "$tmp/aihub-access-logrotate"
grep -Fq 'su root adm' "$tmp/aihub-access-logrotate"
logrotate_sha256="$(sha256sum "$repo_root/ops/nginx/aihub-access-logrotate" | cut -d ' ' -f 1)"
grep -Fq "readonly LOGROTATE_SHA256=$logrotate_sha256" \
  "$repo_root/ops/nginx/aihub-nginx-apply"
sudo chown root:root "$tmp/aihub-access-logrotate"
sudo logrotate --debug --state "$tmp/logrotate.status" \
  "$tmp/aihub-access-logrotate" >/dev/null
for directive in 'daily' 'maxsize 10M' 'ifempty' 'maxage 28' 'rotate 4'; do
  grep -Fq "$directive" "$tmp/aihub-access-logrotate"
done
if grep -Fq 'dateext' "$tmp/aihub-access-logrotate"; then
  printf 'AIHUB access log rotation must preserve numeric archive names.\n' >&2
  exit 1
fi

age_log="$tmp/aihub-access-age.log"
sed \
  -e "s#/var/log/aihub-access.log#$age_log#g" \
  -e '/postrotate/,/endscript/d' \
  "$repo_root/ops/nginx/aihub-access-logrotate" > "$tmp/aihub-access-age.logrotate"
sudo chown root:root "$tmp/aihub-access-age.logrotate"
sudo install -o root -g adm -m 0640 /dev/null "$age_log"
printf 'stale archive\n' | sudo tee "$age_log.3.gz" >/dev/null
sudo touch -d '29 days ago' "$age_log.3.gz"
printf 'recent archive\n' | sudo tee "$age_log.2.gz" >/dev/null
sudo touch -d '2 days ago' "$age_log.2.gz"
sudo logrotate --force --state "$tmp/logrotate-age.status" "$tmp/aihub-access-age.logrotate" >/dev/null
if grep -Fq 'stale archive' "$age_log".*; then
  printf 'AIHUB access log rotation retained a file past maxage.\n' >&2
  exit 1
fi
if ! grep -Fq 'recent archive' "$age_log.3.gz"; then
  printf 'AIHUB access log rotation removed recent history.\n' >&2
  exit 1
fi
install -m 0640 /dev/null "$tmp/aihub-access.log"

node -e '
  const { createServer } = require("node:net");
  const { appendFileSync, readFileSync } = require("node:fs");
  const fixture = readFileSync(process.argv[1]);
  const logPath = process.argv[2];
  const requestId = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const envelope = Buffer.from(JSON.stringify({
    error: {
      code: "INVALID_REQUEST",
      message: "Request failed validation",
      request_id: requestId,
      retryable: false,
    },
  }));
  const metrics = Buffer.from("# TYPE aihub_test_metric gauge\naihub_test_metric 1\n");

  function reply(socket, status, contentType, payload) {
    socket.write(
      `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Bad Request"}\r\n` +
        `Content-Type: ${contentType}\r\n` +
        `Content-Length: ${payload.length}\r\n` +
        `X-Request-Id: ${requestId}\r\n` +
        "Connection: close\r\n\r\n",
    );
    socket.end(payload);
  }

  // A raw server, not node:http, so an unusual method reaches the log instead
  // of being rejected by Node before the request handler runs.
  createServer((socket) => {
    let buffered = Buffer.alloc(0);
    function consume() {
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const head = buffered.subarray(0, headerEnd).toString("latin1");
      const [requestLine, ...headerLines] = head.split("\r\n");
      const [method, url] = requestLine.split(" ");
      const headers = {};
      for (const line of headerLines) {
        const separator = line.indexOf(":");
        if (separator !== -1) {
          headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
        }
      }
      const contentLength = Number(headers["content-length"] ?? 0);
      const total = headerEnd + 4 + contentLength;
      if (buffered.length < total) return;
      socket.off("data", onData);
      appendFileSync(logPath, `${JSON.stringify({
        host: headers.host,
        forwardedHost: headers["x-forwarded-host"],
        method,
        url,
        contentLength: headers["content-length"] ?? null,
        transferEncoding: headers["transfer-encoding"] ?? null,
        realIp: headers["x-real-ip"] ?? null,
        forwardedFor: headers["x-forwarded-for"] ?? null,
        forwardedProto: headers["x-forwarded-proto"] ?? null,
        bodyLength: total - headerEnd - 4,
      })}\n`);
      if (url === "/v1/%E0%A4%A") {
        reply(socket, 400, "application/json", envelope);
      } else if (url === "/metrics") {
        reply(socket, 200, "text/plain; version=0.0.4", metrics);
      } else {
        reply(socket, 200, "application/json", fixture);
      }
    }
    function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      consume();
    }
    socket.on("data", onData);
  }).listen(3021, "127.0.0.1");
' "$fixture" "$tmp/upstream-headers.jsonl" &
backend_pid=$!

for _ in $(seq 1 50); do
  if curl --silent --fail http://127.0.0.1:3021/ >/dev/null; then
    break
  fi
  sleep 0.1
done
curl --silent --fail http://127.0.0.1:3021/ >/dev/null

# Load the actual API and Sandbox server blocks with TLS-only paths removed and
# high local ports substituted. The production locations and gzip directives
# stay intact. Both tiers' private scrape listeners proxy to the same test
# backend, so this proves the listener boundary, not backend routing.
sed \
  -e '/ssl_certificate/d' \
  -e '/include \/etc\/letsencrypt\/options-ssl-nginx.conf/d' \
  -e '/ssl_dhparam/d' \
  -e "s#/var/log/aihub-access.log#$tmp/aihub-access.log#g" \
  -e 's/listen 443 ssl;/listen 127.0.0.1:18080;/' \
  -e 's/listen 80;/listen 127.0.0.1:18081;/' \
  -e 's/listen 127.0.0.1:19103;/listen 127.0.0.1:18082;/' \
  "$repo_root/ops/nginx/aihub-api.conf" > "$tmp/aihub-api.conf"

sed \
  -e '/ssl_certificate/d' \
  -e '/include \/etc\/letsencrypt\/options-ssl-nginx.conf/d' \
  -e '/ssl_dhparam/d' \
  -e "s#/var/log/aihub-access.log#$tmp/aihub-access.log#g" \
  -e 's/listen 443 ssl;/listen 127.0.0.1:18083;/' \
  -e 's/listen 80;/listen 127.0.0.1:18084;/' \
  -e 's/listen 127.0.0.1:19104;/listen 127.0.0.1:18085;/' \
  -e 's#127.0.0.1:3022#127.0.0.1:3021#g' \
  "$repo_root/ops/nginx/sandbox.conf" > "$tmp/sandbox.conf"

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
  include $repo_root/ops/nginx/00-aihub-log-format.conf;
  include $tmp/aihub-api.conf;
  include $tmp/sandbox.conf;
}
EOF

nginx -t -p "$tmp/" -c "$tmp/nginx.conf"
nginx -p "$tmp/" -c "$tmp/nginx.conf"

# curl rejects a malformed percent escape before it sends a request. Use raw
# sockets so the test covers the request line that reaches nginx, including
# methods other than GET and a body that must not be forwarded.
node - "$tmp" <<'NODE'
const { connect } = require('node:net');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const tmp = process.argv[2];

function raw(port, method, target, host, body = '') {
  return new Promise((resolve, reject) => {
    let received = '';
    const socket = connect({ host: '127.0.0.1', port }, () => {
      const headers = [
        `${method} ${target} HTTP/1.1`,
        `Host: ${host}`,
        'Connection: close',
      ];
      if (body) headers.push(`Content-Length: ${Buffer.byteLength(body)}`);
      // Write without end(): a half-closed socket makes nginx discard the
      // response it already produced for the rejected request line.
      socket.write(`${headers.join('\r\n')}\r\n\r\n${body}`);
    });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${method} ${port}: response timed out after ${received.length} bytes`));
    }, 10000);
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => {
      received += chunk;
    });
    socket.on('end', () => {
      clearTimeout(timeout);
      resolve(received);
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function parse(response, label) {
  const split = response.indexOf('\r\n\r\n');
  if (split === -1) throw new Error(`${label}: incomplete response`);
  const head = response.slice(0, split);
  const body = response.slice(split + 4);
  const status = Number(head.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
  const headers = Object.fromEntries(
    head
      .split('\r\n')
      .slice(1)
      .map((line) => line.split(': '))
      .filter(([name]) => name)
      .map(([name, ...value]) => [name.toLowerCase(), value.join(': ')]),
  );
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`${label}: response is not JSON: ${body.slice(0, 200)}`);
  }
  if (status !== 400) throw new Error(`${label}: expected 400, got ${status}`);
  if (!headers['content-type']?.includes('application/json')) {
    throw new Error(`${label}: expected JSON content type, got ${headers['content-type']}`);
  }
  if (payload.error?.code !== 'INVALID_REQUEST' ||
      payload.error?.message !== 'Request failed validation' ||
      payload.error?.retryable !== false ||
      !/^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(payload.error?.request_id ?? '')) {
    throw new Error(`${label}: unexpected envelope: ${body.slice(0, 300)}`);
  }
  if (headers['x-request-id'] !== payload.error.request_id) {
    throw new Error(`${label}: X-Request-Id does not match the envelope`);
  }
  if (/FST_ERR|%E0|Request failed validation.*%/.test(body)) {
    throw new Error(`${label}: response echoed framework or path detail`);
  }
}

const requests = [
  ['GET', 18080, '/v1/%E0%A4%A?private=1', 'api.aihubproduction.com', ''],
  ['POST', 18080, '/v1/%E0%A4%A', 'api.aihubproduction.com', 'body-must-not-forward'],
  ['GARBAGE', 18080, '/v1/%E0%A4%A', 'api.aihubproduction.com', ''],
  ['GET', 18083, '/v1/%E0%A4%A', 'sandbox.aihubproduction.com', ''],
];

(async () => {
  for (const [method, port, target, host, body] of requests) {
    parse(await raw(port, method, target, host, body), `${method} ${port}`);
  }
  const direct = await raw(18080, 'GET', '/__aihub/bad-request', 'api.aihubproduction.com');
  if (!/^HTTP\/1\.1 404 /.test(direct)) {
    throw new Error(`direct internal location: expected 404, got ${direct.split('\r\n', 1)[0]}`);
  }
  const records = readFileSync(join(tmp, 'upstream-headers.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  const malformed = records.filter((record) => record.url === '/v1/%E0%A4%A');
  const expected = [
    ['GET', 'api.aihubproduction.com', 'api.aihubproduction.com'],
    ['POST', 'api.aihubproduction.com', 'api.aihubproduction.com'],
    ['GARBAGE', 'api.aihubproduction.com', 'api.aihubproduction.com'],
    ['GET', 'sandbox.aihubproduction.com', 'sandbox.aihubproduction.com'],
  ];
  if (malformed.length !== expected.length) {
    throw new Error(`expected ${expected.length} malformed upstream requests, got ${malformed.length}`);
  }
  malformed.forEach((record, index) => {
    const [method, host, forwardedHost] = expected[index];
    if (record.method !== method || record.host !== host || record.forwardedHost !== forwardedHost) {
      throw new Error(`upstream request ${index} was ${record.method} ${record.host}/${record.forwardedHost}, expected ${method} ${host}/${forwardedHost}`);
    }
    if (record.contentLength !== null || record.transferEncoding !== null || record.bodyLength !== 0) {
      throw new Error(`upstream request ${index} forwarded body metadata: ${JSON.stringify(record)}`);
    }
    if (record.realIp !== '127.0.0.1' ||
        record.forwardedFor !== '127.0.0.1' ||
        record.forwardedProto !== 'http') {
      throw new Error(`upstream request ${index} has unexpected proxy headers: ${JSON.stringify(record)}`);
    }
  });
  if (records.some((record) => record.url === '/__aihub/bad-request')) {
    throw new Error('direct internal-location request reached the application');
  }
  const access = readFileSync(join(tmp, 'aihub-access.log'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  const malformedAccess = access.filter((record) => record.path === '/v1/%E0%A4%A' && record.status === 400);
  if (malformedAccess.length !== 4 ||
      malformedAccess.map((record) => record.method).join(',') !== 'GET,POST,GARBAGE,GET' ||
      malformedAccess.some((record) => record.request_id !== 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV')) {
    throw new Error(`unexpected malformed access records: ${JSON.stringify(malformedAccess)}`);
  }
  if (access.some((record) => JSON.stringify(record).includes('private=1'))) {
    throw new Error('malformed request query string reached the access log');
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE

curl --silent --show-error -o /dev/null \
  -H 'Host: api.aihubproduction.com' \
  -H 'X-Forwarded-Host: sandbox.aihubproduction.com' \
  'http://127.0.0.1:18080/host-header-check?private-query-marker=do-not-log'
node -e '
  const { readFileSync } = require("node:fs");
  const requests = readFileSync(process.argv[1], "utf8").trim().split("\n");
  const forwarded = JSON.parse(requests.at(-1));
  if (forwarded.host !== "api.aihubproduction.com" ||
      forwarded.forwardedHost !== "api.aihubproduction.com") {
    throw new Error(`Nginx forwarded caller-controlled host: ${JSON.stringify(forwarded)}`);
  }
  const accessLines = readFileSync(process.argv[2], "utf8").trim().split("\n");
  const access = JSON.parse(accessLines.at(-1));
  const expectedKeys = ["timestamp", "client_ip", "request_id", "method", "path", "status"];
  if (JSON.stringify(Object.keys(access).sort()) !== JSON.stringify(expectedKeys.sort()) ||
      !Number.isFinite(access.timestamp) ||
      access.client_ip !== "127.0.0.1" ||
      access.request_id !== "req_01ARZ3NDEKTSV4RRFFQ69G5FAV" ||
      access.method !== "GET" ||
      access.path !== "/host-header-check" ||
      access.status !== 200 ||
      JSON.stringify(access).includes("private-query-marker")) {
    throw new Error(`Unexpected AIHUB access record: ${JSON.stringify(access)}`);
  }
' "$tmp/upstream-headers.jsonl" "$tmp/aihub-access.log"
test "$(stat -c '%a' "$tmp/aihub-access.log")" = 640

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

curl --silent --show-error --fail http://127.0.0.1:18082/metrics > "$tmp/private-metrics.prom"
grep -Fxq 'aihub_test_metric 1' "$tmp/private-metrics.prom"
if curl --silent --show-error -o /dev/null -w '%{http_code}' \
  -H 'Host: api.aihubproduction.com' http://127.0.0.1:18080/metrics | grep -Fxq '200'; then
  printf 'The public API listener unexpectedly exposed /metrics.\n' >&2
  exit 1
fi
if curl --silent --show-error -o /dev/null -w '%{http_code}' \
  http://127.0.0.1:18082/health | grep -Fxq '200'; then
  printf 'The private scrape listener unexpectedly proxied a non-metrics path.\n' >&2
  exit 1
fi

curl --silent --show-error --fail http://127.0.0.1:18085/metrics > "$tmp/sandbox-private-metrics.prom"
grep -Fxq 'aihub_test_metric 1' "$tmp/sandbox-private-metrics.prom"
if curl --silent --show-error -o /dev/null -w '%{http_code}' \
  -H 'Host: sandbox.aihubproduction.com' http://127.0.0.1:18083/metrics | grep -Fxq '200'; then
  printf 'The public Sandbox listener unexpectedly exposed /metrics.\n' >&2
  exit 1
fi
if curl --silent --show-error -o /dev/null -w '%{http_code}' \
  http://127.0.0.1:18085/health | grep -Fxq '200'; then
  printf 'The private Sandbox scrape listener unexpectedly proxied a non-metrics path.\n' >&2
  exit 1
fi
