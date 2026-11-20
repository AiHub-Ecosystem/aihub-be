# Response compression evaluation

Status: evaluation for [#1587](https://github.com/AiHub-Ecosystem/aihub-be/issues/1587). This is a decision record, not an authorization to change the runtime bootstrap or the deployed nginx configuration.

## Scope

This evaluation answers whether AIHUB's Fastify process should compress public API
responses. It covers response bodies only. It does not cover request compression,
fast-json-stringify serialization (#1211), or lazy deserialization (#1282). It also does
not cover image transcoding: the `sharp` matches under `src/modules/avatar/` are image
encoding, not HTTP content encoding.

The candidate mechanisms were:

- `@fastify/compress` in `src/main.ts`, honoring `Accept-Encoding`, with a threshold
  and a choice between gzip and brotli; and
- nginx `gzip` on the edge, which the deployment already configures for the API host.

## Findings

### Application process

`src/main.ts` has no compression plugin. Registration order is: request hooks
(`registerRequestHooks`, which starts the shared timer first), `fastifyCookie`, the
Speaking multipart parser, then the metrics route. Adding `@fastify/compress` would add
a new runtime dependency and a `onSend` hook on every response, including `/metrics`,
`/health`, and management routes, unless scoped by path.

No `@fastify/compress` dependency exists in `package.json` or `bun.lock`. No response
compression code exists under `src/`.

### Edge

`ops/nginx/aihub-api.conf` enables gzip at server level only inside the two Speaking
locations:

```
location = /v1/ielts/speaking/grading { gzip on; gzip_types application/json; ... }
location = /v1/ielts/speaking/grading-json { gzip on; gzip_types application/json; ... }
```

Every Writing route (`/v2/ielts/writing/task1/grade`, `task2/grade`,
`micro-exercises`, `long-writing-exercises`, `micro-exercises/grade`) and the catch-all
`location /` carry `gzip off`. The 2026-11-05 comment on #1587 records that these are
large JSON payloads, commonly 20–50 KB of feedback and annotations. The `gzip off`
directives sit beside long `proxy_read_timeout` / `proxy_send_timeout` values (up to
135 s for Writing grading, ADR-0143); the config does not state that compression caused
those timeouts, and nothing in the repository records a failed compression attempt on
these routes.

`ops/nginx/check-gzip.sh` already derives a temporary nginx config from the production
files and asserts that the API's catch-all stays outside compression scope. A change to
the production gzip directives must keep that check green.

### Effectiveness

The bandwidth claim in the issue (gzip roughly 65% smaller than uncompressed JSON,
brotli a further 15–25%) is directionally correct for text with repeated structure.
It does not establish that the customer-facing hop is the bottleneck, or that the extra
CPU and buffering help a path whose dominant latency is the 60–125 s AI Service call.
No measurement in the repository compares response size, edge-to-customer latency, or
CPU on AIHUB's shared two-vCPU host with and without compression.

Compressing at both layers is possible but wasteful: nginx will not recompress an
upstream response that already carries `Content-Encoding: gzip`, so an app-level plugin
would make the edge `gzip on` settings inert for those responses. Choosing one layer
keeps the behavior inspectable.

## Decision

**Defer the app-level plugin. Fix coverage at the edge instead.**

Do not add `@fastify/compress` to `src/main.ts` under this issue. The application is not
the layer that currently suppresses compression on Writing responses; the deployed
nginx config is. Adding Fastify compression would also change `/metrics`, `/health`,
and management responses unless path-scoped, for no measured benefit over the edge.

The follow-up, owned separately from this evaluation, is to enable nginx gzip for the
Writing JSON locations in `ops/nginx/aihub-api.conf` with `gzip_types application/json`,
`gzip_vary on`, and `gzip_proxied any`, keeping the temporary `check-gzip.sh` assertion
that unrelated catch-all routes remain out of scope. It must keep the 135 s Writing
proxy timeouts unchanged and verify on the host that the `Accept-Encoding: gzip` path
returns `Content-Encoding: gzip` without changing the public response envelope. Treat
that as a production behavior change with its own evidence, not as a docs-only edit.

Rules that hold regardless of layer:

- Preserve the success envelope and error codes; compression changes bytes on the wire,
  not the parsed contract.
- Never compress the `/metrics` scrape or health probes.
- Keep `Vary: Accept-Encoding` so caches do not serve a compressed body to a client
  that cannot decode it.
- Do not compress the multipart audio request path; this evaluation is response-only.

## Revisit triggers

Revisit the app-level decision when one of these holds:

- an edge change is impossible for a deployment that still needs compression (for
  example a consumer that bypasses nginx);
- measured host metrics show the edge cannot absorb compression CPU while meeting the
  #581 capacity policy, but an application-level threshold can;
- a new streaming response cannot be buffered at the edge and needs an `onSend` hook;
- a measured customer-side trace identifies TTFB on the graded-response hop as the
  dominant latency, with before/after bytes and timing recorded.

## Issue status

The acceptance criterion of #1587 is a recorded decision with evidence. This document
supplies it: the observation that nginx, not Fastify, suppresses Writing compression,
the effectiveness limits, the decision to defer the plugin, and the edge follow-up with
its revisit triggers. The issue can close on this evidence; the nginx edit belongs to a
separate production-behavior issue.
