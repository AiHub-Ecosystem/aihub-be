# ADR-0018: Organization monthly quota uses a heuristic Redis gate

- Status: Accepted; production replay handling amended by #659/#632; sandbox dispatch budgets amended by ADR-0056
- Related issue: #51
- Related issue: #53

AIHUB enforces `organizations.monthly_request_quota` per organization and UTC calendar month with a Redis quota counter. The gateway reads that counter before concurrency admission; only billable, non-replayed successful requests increment it at the metering boundary, while nullable quotas, non-model operations, and sandbox assertion minting bypass the gate. `usage_records` remains the durable source of truth; Redis is a fast heuristic with a 40-day TTL, and bounded concurrent overshoot is accepted for separate reconciliation in #53. When Redis is unavailable, hard-stop organizations fail closed with the existing `QUOTA_EXCEEDED` 429, while other organizations proceed and every allowed-through request is marked `quota_unverified`. This deliberately avoids distributed reservation/rollback and a new public error contract. At exhausted production quota, an exact completed Writing replay is admitted without another quota increment; new requests, pending duplicates, and mismatched-body requests remain subject to the quota refusal.

## Amendment for #182 (ADR-0056)

ADR-0056 adds an independent, durable dispatch allowance for sandbox traffic: 25 monthly dispatches per customer Organization and 500 across the sandbox Environment, enforced by atomic reservations in sandbox Postgres. These reservations count downstream dispatches even when they fail or time out, fail closed when their store is unavailable, and do not touch production quota. Completed Writing idempotency replays are resolved before sandbox reservation and remain available after quota exhaustion. These rules amend ADR-0018 only for sandbox; production keeps the heuristic Redis quota, with replay behavior further amended below for #659/#632.

## Amendment for #659 and #632 (2026-10-20)

This amendment supersedes the original production replay rule above. At exhausted monthly quota, AIHUB admits a completed Writing replay only when the same Organization, operation, idempotency key, and request body match a durable completed record. The Organization retry budget is checked first; an over-budget repeat receives `429 RATE_LIMITED` with `Retry-After`. An admitted replay returns the stored result without dispatch, billing, or another quota increment. A new key, pending duplicate, or body mismatch remains refused at exhausted quota. When a hard-stop quota counter is unavailable, a confirmed completed Writing replay is still served; if the durable idempotency match cannot be confirmed, the existing fail-closed `QUOTA_EXCEEDED` response remains.
