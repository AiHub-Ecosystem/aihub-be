# ADR-0168: Publish IELTS practice content on /v2 with cursor pagination

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-11-14
- Date: 2026-11-14
- Supersedes: [ADR-0166](0166-proxy-legacy-content-backend-lists.md)
- Related: [ADR-0127](0127-public-api-uri-major-versioning.md), [ADR-0129](0129-public-route-and-response-convention.md), [ADR-0130](0130-collection-routes-are-paginated-by-limit-and-cursor.md), [ADR-0142](0142-a-released-contract-defect-is-corrected-through-an-accepted-change-entry.md), [#1916](https://github.com/AiHub-Ecosystem/aihub-be/issues/1916)

## Context

ADR-0166 temporarily proxied four unauthenticated endpoints (`/api/WritingTemplate`, `/api/Speaking/library`, `/v1/listening/tests`, `/v1/reading/tests`) directly from the legacy backend. As identified in review, this deviated from AIHUB architectural conventions:

1. Exam content routes should live under the `/vN/ielts/<skill>/...` prefix (ADR-0129).
2. Collection routes must paginate with `limit` and `cursor`, returning `{ data: { <collection>, next_cursor } }` (ADR-0130), rather than upstream `page`/`pageSize` and camelCase metadata.
3. Upstream response properties used camelCase (`taskType`, `imageUrl`), inconsistent with AIHUB's snake_case schema conventions.
4. Public `/v1` is deprecated (sunset 2027-11-02 per ADR-0127), so new feature additions belong on active major `/v2`.
5. No client or frontend has integrated the unversioned `/api/*` or temporary `/v1` routes yet.

## Decision

1. **Retire temporary routes**: Remove `/api/WritingTemplate`, `/api/Speaking/library`, `/v1/listening/tests`, and `/v1/reading/tests`. Removing the two `/v1` routes from `/v1` contract 1.13.0 is recorded as an accepted breaking change in `accepted-breaking-changes.json` under ADR-0142 since no consumer integrated them in the few hours since publication.
2. **Publish on /v2**: Publish five clean, unauthenticated endpoints on `/v2` under the `ielts` prefix:
   - `GET /v2/ielts/writing/task1/templates`
   - `GET /v2/ielts/writing/task2/templates`
   - `GET /v2/ielts/speaking/library`
   - `GET /v2/ielts/listening/tests`
   - `GET /v2/ielts/reading/tests`
3. **Cursor pagination**: All five routes accept optional `limit` (integer 1..200, default 20) and `cursor` (opaque base64url string encoding `{ page, limit }`), conforming to ADR-0130. A cursor is bound to the `limit` it was issued with: a request that sends a different `limit` with it is `400 INVALID_REQUEST`. Responses return `{ data: { <items>, next_cursor } }`. The legacy backend honours only `page` and `pageSize`, so Speaking, Listening and Reading forward the page window upstream. It returns the whole Writing list unpaginated, so the two Writing routes fetch the full list and slice the page in memory.
4. **Canonical snake_case schemas**: Response items are strictly mapped from upstream payloads into canonical snake_case TypeBox schemas. Author fields (`user_id`, `user_name`) and user attempt metrics (`user_attempt_count`, `attempt_count`) are dropped from anonymous public responses.
5. **Contract versioning**: `/v1` moves to `1.14.0` (with accepted deletion entry); `/v2` contract moves to `2.7.0`.

## Consequences

- The public API surface for IELTS practice content is consistent with ADR-0129 and ADR-0130 across all skills.
- The temporary `/api/*` and `/v1` endpoints are completely removed.
- Clients paginate uniformly via `limit` and `cursor`.
- The routes launched without caller authentication, rate limiting, or caching. Every Writing request costs a full upstream fetch (about 135 KB for Task 1). The limit and the cache decision are tracked in [#1916](https://github.com/AiHub-Ecosystem/aihub-be/issues/1916).

## Agreed follow-up for #1916

The five routes share a budget of 30 requests per IP in Redis. Use the client
address that Fastify resolves through the trusted proxy. The first request
starts a 60-second window. Count every request before checking `limit` or
`cursor`. An over-budget request receives `429 RATE_LIMITED` and `Retry-After`
based on the remaining window, with the standard error envelope.

Customer Web [`dev` at `aac5521`](https://github.com/AiHub-Ecosystem/AiHub-Frontend/tree/aac5521e92e41d499cd16d97ca5ead9beada36a4)
had no browser or BFF callers for these routes. Production nginx and application
logs showed no matching requests in the seven days ending 2026-11-27 04:53 UTC.
The initial budget allows an IP to read two pages on each route three times per
window. Revisit the budget before Customer Web BFF integration. Evaluate caching
the full Writing lists when there is traffic data to estimate savings.

During a Redis outage, use a separate process-local counter with the same
allowance and up to 10,000 active IPs. Two serving slots allow 30 requests per IP
in each slot's local window. Keep active entries until expiry. At capacity, a
request from an IP without an active entry receives retryable
`503 REDIS_UNAVAILABLE`. Resume shared counting when Redis recovers. The
[degraded-mode matrix](../superpowers/specs/2026-09-07-aihub/14-degraded-mode-matrix.md)
records this fallback alongside its proof.

All five operations publish `429` and `Retry-After` in the `/v2` 2.13.0
contract, recorded in `CHANGELOG.md`. The HTTP test exhausts one IP's shared
budget through the trusted proxy and shows another IP can still access the
routes.
