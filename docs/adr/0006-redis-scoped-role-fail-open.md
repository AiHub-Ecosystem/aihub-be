# ADR-0006: Redis has a scoped role and fails open where blocking costs more

- Status: Accepted (retroactive record; graded-route behavior amended by ADR-0116)
- Date: decided 2026-09-07 in the implementation specification suite; file written 2026-11-07

## Context

Redis holds only cache, counters, and protection state. The question is not
"does Redis fail?" — it will — but what each consumer does at that moment.

## Decision

Redis is a cache/counter/protection layer, never the durable source of truth
for identity, usage, quota, or idempotency. Per-consumer outage behavior
([04-redis §F.5](../superpowers/specs/2026-09-07-aihub/04-redis.md)):

| Lost capability        | Behavior                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| API key cache          | Fall back to Postgres                                                    |
| Brute-force protection | Allow through + alert (256-bit keys cannot be brute-forced in an outage) |
| Rate limiting          | Graded: refuse 503; non-graded: allow through + local backstop           |
| Concurrency limiting   | Refuse 503 `REDIS_UNAVAILABLE`                                           |
| Quotas                 | Graded: refuse 503; non-graded: allow through + `quota_unverified`       |
| JWKS cache             | Fetch directly from upstream                                             |
| Auth & authorization   | **Zero Redis dependency** — never "Redis is down, so grant access"       |

The principle: **passing a request can be reconciled, blocking cannot.**
Every admitted request is recorded durably in `usage_records`; the morning
after an outage, operators decide with full data whether to invoice the
overrun or forgive it. Rejecting a student's essay instead destroys customer
trust, which no operational action can undo.

The absolute boundary stands separately from the economics: failing open on
rate limiting risks money; failing open on authorization risks customer data.

## Consequences

- ADR-0116 amended the graded rows: rate limiting, the Organization retry
  budget, quota, and the concurrency permit on graded routes are **verified
  Redis decisions** — a Redis error or ambiguous result refuses with retryable
  `503 REDIS_UNAVAILABLE`; no local counter admits a graded request. The
  fail-open rows above now cover non-graded routes only.
- Post-result quota increments still mark usage `quota_unverified` rather than
  fabricating data.
- `maxmemory-policy` is `noeviction`, not `allkeys-lru`: LRU eviction could
  silently reset a near-ceiling organization's quota counter, while
  `noeviction` turns memory pressure into visible write errors that the
  fail-open paths already handle.
- Durable control-plane data (API-key hashes, identity configuration, usage,
  idempotency) never lives in Redis (source-boundary rules).
