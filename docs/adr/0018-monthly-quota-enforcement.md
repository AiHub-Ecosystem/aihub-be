# ADR-0018: Organization monthly quota uses a heuristic Redis gate

- Status: Accepted
- Related issue: #51
- Related issue: #53

AIHUB enforces `organizations.monthly_request_quota` per organization and UTC calendar month with a Redis quota counter. The gateway reads that counter before concurrency admission; only billable, non-replayed successful requests increment it at the metering boundary, while nullable quotas, non-model operations, and sandbox assertion minting bypass the gate. `usage_records` remains the durable source of truth; Redis is a fast heuristic with a 40-day TTL, and bounded concurrent overshoot is accepted for separate reconciliation in #53. When Redis is unavailable, hard-stop organizations fail closed with the existing `QUOTA_EXCEEDED` 429, while other organizations proceed and every allowed-through request is marked `quota_unverified`. This deliberately avoids distributed reservation/rollback and a new public error contract; quota admission remains before idempotency, so a replay at an exhausted quota is rejected rather than consuming another unit.
