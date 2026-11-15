# ADR-0168: Gateway admission limits are shared across application instances

- Status: Accepted
- Date: 2026-11-14
- Related issue: [#1571](https://github.com/AiHub-Ecosystem/aihub-be/issues/1571)
- Related: [ADR-0006](0006-redis-scoped-role-fail-open.md), [ADR-0056](0056-customer-sandbox-test-tier.md), [ADR-0057](0057-graded-request-order-is-a-declared-contract.md), [ADR-0113](0113-organization-and-service-retry-budgets.md), [ADR-0116](0116-post-result-grading-completion-timing.md), [ADR-0144](0144-in-process-singleflight-request-coalescing.md)
- Amends: [ADR-0006](0006-redis-scoped-role-fail-open.md) for non-graded rate-limit outages

## Context

AIHUB may run multiple application processes against the same Redis and
PostgreSQL services. Admission limits must keep the same aggregate scope as the
customer policy when requests reach different processes.

The normal `RedisRateLimiter` path increments a Redis counter shared with
graded admission, but it currently falls back to an in-memory counter when its
Redis client is missing or fails. `RedisGradedAdmission` makes its rate-limit,
Organization retry-budget, and quota decision in Redis and fails closed. The
Sandbox dispatch budget reserves against PostgreSQL under a transaction and a
UTC-month advisory lock. These Redis and PostgreSQL paths already coordinate
across processes; the rate-limit fallback does not.

ADR-0006 chose fail-open with a local backstop for non-graded rate limits and
ADR-0116 amended graded admission to fail closed. The difference means the
same API key can continue through non-graded routes while a graded request is
refused during a Redis outage.

ADR-0113 already defines the Organization retry budget as cross-instance. Its
per-service AIHUB-to-service retry bucket remains proposed until capacity
evidence exists. ADR-0144 defines generic in-process `Singleflight`; it is
currently used by XFetch cache reads, not by graded admission.

## Decision

1. **API-key rate limit:** Keep the configured per-key limit in a shared Redis
   counter. All application instances using that Redis enforce one API-key
   allowance; adding instances does not multiply it.
2. **Organization retry budget:** Keep the existing cross-instance policy in
   ADR-0113. For an Organization, the allowance in a rolling 60-second window
   is `max(1, floor(0.10 × first_attempts))` same-key repeats for operations
   that support idempotency. This decision does not enable or change the
   proposed per-service retry bucket.
3. **Sandbox dispatch reservations:** Keep the PostgreSQL transaction and
   UTC-month reservation policy. Each Organization's monthly allowance and
   the shared Sandbox ceiling of 500 dispatches apply across every application
   instance. A repeated reservation for the same request within the same
   Organization remains idempotent.
4. **Redis outage behavior:** Both the non-graded rate limiter and graded
   admission fail closed when Redis is not configured or cannot verify a
   decision. They return retryable `503 REDIS_UNAVAILABLE` with the existing
   retry hint. The non-graded rate limiter does not use a process-local
   fallback. This amends only the non-graded rate-limit row of ADR-0006; its
   other outage decisions remain in force.
5. **Singleflight:** Keep request coalescing process-local. For one key, each
   process may run at most one matching in-flight loader; K processes may run
   up to K loaders for the same key. Singleflight does not enforce a customer
   quota and is not part of graded admission.

When simultaneous requests contend for a remaining allowance, Redis or
PostgreSQL serialization decides their order. The contract is the aggregate
limit and idempotent accounting, not that the same request wins under every
possible process schedule.

## Verification plan

Issue #1571 will add tests that run two independent Node processes against
shared test Redis and PostgreSQL services. They will prove that:

- concurrent API-key and graded admission across both processes do not exceed
  their shared limits, and both rate-limit paths refuse when Redis is
  unavailable;
- Organization same-key retries stay within the ADR-0113 allowance, while a
  replay admitted by one process is not counted or billed again by the other;
- Sandbox reservations across both processes do not exceed either the
  Organization allowance or the shared 500-dispatch monthly ceiling, and a
  repeated request does not reserve another unit; and
- a request with available capacity is not refused or loses its reservation
  solely because the other process contends for the same limit.

The tests do not require a deterministic winner among simultaneous requests.
Until these tests and the implementation pass, this ADR records the accepted
target contract, not evidence that the runtime already meets it.

## Consequences

- Replicas do not multiply API-key rate limits, Organization retry allowances,
  or Sandbox dispatch budgets.
- Non-graded admission is unavailable while Redis cannot verify its rate-limit
  decision, matching graded admission and avoiding an outage bypass through a
  different route.
- Process-local singleflight may still allow one simultaneous cache load per
  process for the same key. That can increase duplicate upstream reads as the
  instance count grows, but it does not change grading admission or customer
  quota.
- The Sandbox monthly advisory lock remains a shared serialization point; this
  decision does not change its lock granularity.
