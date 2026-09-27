# ADR-0018: Organization monthly quota uses a heuristic Redis gate

- Status: Accepted; sandbox dispatch budgets amended by ADR-0056
- Related issue: #51
- Related issue: #53

AIHUB enforces `organizations.monthly_request_quota` per organization and UTC calendar month with a Redis quota counter. The gateway reads that counter before concurrency admission; only billable, non-replayed successful requests increment it at the metering boundary, while nullable quotas, non-model operations, and sandbox assertion minting bypass the gate. `usage_records` remains the durable source of truth; Redis is a fast heuristic with a 40-day TTL, and bounded concurrent overshoot is accepted for separate reconciliation in #53. When Redis is unavailable, hard-stop organizations fail closed with the existing `QUOTA_EXCEEDED` 429, while other organizations proceed and every allowed-through request is marked `quota_unverified`. This deliberately avoids distributed reservation/rollback and a new public error contract; quota admission remains before idempotency, so a replay at an exhausted quota is rejected rather than consuming another unit.

## Amendment for #182 (ADR-0056)

ADR-0056 adds an independent, durable dispatch allowance for sandbox traffic: 25 monthly dispatches per customer Organization and 500 across the sandbox Environment, enforced by atomic reservations in sandbox Postgres. These reservations count downstream dispatches even when they fail or time out, fail closed when their store is unavailable, and do not touch production quota. Completed Writing idempotency replays are resolved before sandbox reservation and remain available after quota exhaustion. These rules amend ADR-0018 only for sandbox; production keeps the heuristic Redis quota and quota-before-idempotency behavior.
