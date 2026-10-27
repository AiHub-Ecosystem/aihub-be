# ADR-0116: Measure post-result grading completion through persistence

- Status: Accepted; amended by [#1358](https://github.com/AiHub-Ecosystem/aihub-be/issues/1358) (`RETRY_BUDGET_UNAVAILABLE` is reserved and no longer emitted)
- Related issue: #472
- Amends: [ADR-0089](0089-ingress-based-request-timing.md) (admission labels only), [ADR-0018](0018-monthly-quota-enforcement.md) (graded Redis-control outages only), `04-redis.md` §F.5 (graded rate limit, concurrency, and quota rows; recorded 2026-10-22 by #328)

## Context

Ingress timing intentionally ends before metering persistence and response
delivery. It cannot show how much time a successful grading spends persisting
usage or releasing its distributed concurrency permit. Admission measurements
also need to distinguish the identity and retry-budget paths exercised by a
benchmark.

## Decision

Keep `total_ms` and `aihub_request_duration_seconds` on their ingress-based
boundary. Add `aihub_graded_completion_duration_seconds`, starting when an AI
Service result is available and ending after usage persistence and the
concurrency permit release settle. Keep this duration separate from `total_ms`
and downstream duration.

Add only bounded `identity_mode` (`declared_id` or `signed_assertion`) and
`retry_budget` (`keyed_writing` or `none`) dimensions to admission and graded
completion histograms, alongside the catalog operation. Requests without
resolved dimensions use fixed `unknown` and `none` values.

For graded admission, a Redis error or ambiguous mutation returns retryable
`503 REDIS_UNAVAILABLE`. Do not use local counters or report a rate, retry
budget, quota, or concurrency refusal without a verified Redis decision. Keep
the confirmed completed Writing replay at exhausted quota before concurrency
acquisition. A post-result quota increment failure keeps the existing
`quota_unverified` metering behavior.

## Consequences

Operators can compare admission and post-result completion distributions by
the paths that have different work, without changing public response timing or
durable usage totals. A background Writing completion records its completion
histogram when billing and permit settlement finish, even though its earlier
504 response has already been logged.

### Amendment ([#1358](https://github.com/AiHub-Ecosystem/aihub-be/issues/1358))

`RETRY_BUDGET_UNAVAILABLE` is reserved: AIHUB no longer returns it. The
Organization retry budget is one step of graded admission, so when Redis
cannot answer, the refusal is `503 REDIS_UNAVAILABLE` whichever step could not
be verified. The standalone retry-budget adapter that used to return the other
code was removed by [#1312](https://github.com/AiHub-Ecosystem/aihub-be/issues/1312).

The value stays in `ErrorCode`, the error registry, and the OpenAPI enum.
Removing it would narrow a published response enum and fail the API
compatibility and Customer Web contract checks, for no change in what a client
receives. A client that already handles it treats it like `REDIS_UNAVAILABLE`:
retry after `retry_after_ms`. The value can be removed at the next breaking
contract version.
