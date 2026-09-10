# 02 — Request Lifecycle

← [Table of Contents](README.md) · [01 — Context & Stack](01-context-and-stack.md)

## D.1 Pipeline — Deliberate Execution Order

Guiding principle: **cheap operations first, expensive operations later; fail closed**.

```
 1. request_id (ULID) + start timer          middleware, zero I/O
 2. environment <- Host header               middleware, zero I/O
 3. IP-level guard (counts auth failures)    Redis
 4. API Key auth                             Redis cache -> Postgres
 5. environment binding check                in-memory, from step 4
 ─────────── only here is the tenant organization known ───────────
 6. parse + validate body (JSON Schema)      Fastify, bodyLimit per operation
 7. User Assertion verify                    JWKS cache -> signature verification
 8. effective scope = entitlement ∩ key scope
 9. authorize(operation.required_scope)
10. rate limit + quota + concurrency         Redis
11. idempotency check                        Postgres
════════════════ COST / MONETIZATION BOUNDARY ════════════════
12. resolve downstream + buildRequest
13. mint internal JWT (TTL 60s)
14. HTTP call via undici (timeout + circuit breaker)
15. parseResponse / mapError
16. record usage_records
17. package response { data, meta }
```

### Three rationales for this order

**Auth (4) before body validation (6).** Malformed junk requests lacking a valid key get rejected right after reading headers — zero wasted effort parsing 20KB of JSON. This is also why `bodyLimit` is configured per operation rather than globally.

**Step 3 exists because step 4 is the brute-force attack surface.** An organization-scoped rate limit cannot protect against someone actively _guessing_ keys — at that stage the tenant organization has not been identified. A preliminary IP guard is required, and it only counts **failures**, so legitimate customers will never trigger it even when bursting 50 RPS from a single IP.

**The line after step 11 is the "Cost Boundary".** Everything above the line must fail fast and cheaply; everything below the line may invoke models and incur actual monetary expense. Idempotency **must** reside immediately above the line, never below it.

## D.2 Mapping to NestJS

Maps nearly 1-to-1 with NestJS's native execution lifecycle, requiring no bespoke framework.

| Step       | Nest construct                                        |
| ---------- | ----------------------------------------------------- |
| 1, 2       | Middleware                                            |
| 3, 4, 5    | `ApiKeyGuard`                                         |
| 7, 8, 9    | `UserAssertionGuard` → `ScopeGuard`                   |
| 10         | `RateLimitGuard`                                      |
| 6          | Pipe (executes after Guards — exactly as intended)    |
| 11, 16, 17 | Interceptor (wraps handler)                           |
| 12–15      | Service: Registry → Adapter → Dispatcher → HttpClient |
| error      | Single centralized `ExceptionFilter`                  |

Controllers merely declare operations and invoke the dispatcher. **No controller ever inspects raw request headers** — identity is normalized into `RequestContext` by upstream guards.

## D.3 Lifecycle 1 — Successful Synchronous Request

`POST /v1/ielts/writing/task1/grade`

```
Customer BE ──X-API-Key, X-User-Assertion, Idempotency-Key──► AIHUB
                                          t0 ─┐
   req_01J... ; env=production                │  steps 1-11: ~3-8ms
   org_abc ; actor=student_123                │
   scope OK ; quota OK ; idem: not seen       │
                                          t1 ─┤
   ──Bearer <internal JWT, exp=t1+60s>──► ai-writing        │
       POST /grading-feedback-task1                         │ downstream_ms
   ◄── { ...fields, usage{}, models[], metrics{} } ──       │
                                          t2 ─┤
   splitEnvelope -> parseResponse -> record usage_records
                                          t3 ─┘
◄── 200 { data, meta{ request_id, usage, timing } }

total_ms = t3-t0    downstream_ms = t2-t1    gateway_overhead_ms = total - downstream
```

Timing definitions conform strictly to D1 §14 and target architecture §17.1. We do not assume `total_ms = gateway_overhead_ms + ai_processing_ms`, because `downstream_ms` includes network transmission and overhead within the AI Service itself.

## D.4 Lifecycle 2 — Downstream Failure

```
   ──► ai-writing ─╳─ ECONNREFUSED / 503 / timeout
                    │
       circuit breaker records failure (ONLY 5xx/timeout/connection error)
                    │
       retry ONLY if the request was never transmitted  (see 07 §I.2)
                    │
       503 AI_SERVICE_UNAVAILABLE  /  504 AI_SERVICE_TIMEOUT
       idempotency: 5xx -> failed (permits retry) ; 4xx -> DELETE record
       usage_records: outcome=downstream_error, usage=null
                    ▼
◄── { error: { code, message, request_id, retryable, retry_after_ms } }

Internal logs retain: private_endpoint, downstream_status, downstream_error_code, downstream_ms.
The client never sees any of these fields.
```

## D.5 Lifecycle 3 — Async Media (Phase 4, Contract Frozen Now)

```
POST /v1/speaking/grade
  -> write jobs(status=queued) to Postgres   ← source of truth
  -> push job id to BullMQ                   ← execution queue only
  -> 202 { data: { job_id, status: "queued" } }

worker: jobs.status=running -> AI Speaking -> jobs.status=succeeded + result

GET /v1/jobs/{job_id}
  -> 200 { data: { job_id, status, result?, error? } }
```

**Rule that must be locked in immediately, even though implementation is in Phase 4:**

> The `jobs` table in Postgres is the **source of truth** for all jobs. Redis/BullMQ is merely an ephemeral execution queue.

Losing Redis means losing the transient execution queue, not the actual jobs — a background reconciler scans `jobs` stuck in `queued` status past a threshold and reenqueues them. If job state lived only in Redis, a single Redis outage would permanently drop student essay submissions, resulting in unrecoverable customer data loss.

Freezing the async contract now in D1 ensures that onboarding Speaking later requires no breaking changes to the public API — even if implementation is distant.

---

→ Next: [03 — Database](03-database.md)
