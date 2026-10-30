# ADR-0097: Billing statements, adjustments, closed months, and late Writing results

- Status: Accepted
- Date: 2026-10-14
- Related issues: [#404](https://github.com/AiHub-Ecosystem/aihub-be/issues/404), [#405](https://github.com/AiHub-Ecosystem/aihub-be/issues/405), [#911](https://github.com/AiHub-Ecosystem/aihub-be/issues/911)
- Amends: [ADR-0016](0016-metering-boundary-and-billing-evidence.md) for what a usage record bills and how a month is billed
- Related: [ADR-0018](0018-monthly-quota-enforcement.md), [ADR-0023](0023-thirteen-month-usage-retention.md), [#393](https://github.com/AiHub-Ecosystem/aihub-be/issues/393)

## Context

ADR-0016 makes `usage_records` the billing evidence, but nothing turned that evidence into a bill. The query documented in spec 08 had no upper month bound, so billing a past month with it also counted every later month. There was no way to credit a disputed charge without editing evidence, no way to keep AIHUB's own smoke and canary traffic off a customer's bill, and nothing recorded what a past month billed once pruning, redaction or a restore could change the rows.

Separately, a Writing grading that AIHUB finishes in the background after answering `504` was never billed: the `504` record is non-billable, and every replay that delivers the stored result is non-billable too. The integration guide implied the customer pays for one run; the code charged none, and the work never counted toward quota.

## Decision

**Billable unit.** Unchanged: one successful, non-replayed request, every operation weighted equally.

**What a statement bills.** For one Organization (or all) and one UTC calendar month, `billing:statement` bills usage records with `outcome = 'success'`, `billable_requests = 1`, `environment = 'production'`, made with a key not marked internal. The month is `[first instant, first instant of next month)` of `created_at`, which is set when the request completes. Each line also counts what it excluded and why: replays, failures, internal keys, non-Production environments; billed records whose quota increment could not be confirmed are flagged as `quota_unverified`.

**Internal traffic is marked per API key.** `api_keys.internal` marks a key AIHUB itself uses. Operators create one with `key:create --internal true`. Its traffic is metered as usual, left off the statement, and shown on its own line.

**Adjustments.** A correction is a row in the append-only `billing_adjustments` table, written only by `billing:adjust`, with the actor, a reason, a signed request count, and either the request ids or the period it corrects. It never modifies `usage_records`. A statement shows each adjustment beside the evidence and adds it to the total.

An adjustment's `badj_<ULID>` primary key is also its retry identity. `billing:adjust` requires the operator to provide it with `--id`; retrying the same ID with the same Organization, month, operation, count, reason, target, and actor returns the existing adjustment. Reusing the ID with any different value is refused, while a new ID records a distinct adjustment. The operator reuses the exact ID when the command's output or acknowledgement is uncertain.

**Closing a month.** `billing:statement --close true --actor <username>` stores the month's per-operation totals in the append-only `billing_month_closures` table, once the month has ended. Running the statement again for a closed month compares the current evidence with what was stored and reports each difference; it never overwrites. A closed month takes no further adjustments: late evidence or a later correction is recorded as an adjustment in the next open month, naming the period it corrects. An adjustment that races a close can land after the close read its totals; the next statement for that month reports it as a difference.

**A Writing grading completed after its `504`** is billed once, when the background work stores its result, whether or not the customer ever fetches it. AIHUB writes a second usage record for it under `<request id>:background`, with `billing_basis = 'background_completion'`, billable once and counted against the Organization's quota once at that moment. The `504` record stays non-billable and unchanged, and replays stay non-billable, so no number of retries charges again. A replay at an exhausted quota keeps its ADR-0018 behaviour. `billing_basis` lets a statement show these charges separately from ordinary responses.

## Considered options

- **Charge on the first replay** instead of at completion: bills only results a customer fetched, but needs a new "already charged" marker on the idempotency record and lets a hard-stopped Organization receive gradings past its limit; rejected.
- **Mark internal traffic per Organization**: simpler, but works only while every smoke and canary key lives in an Organization of AIHUB's own; rejected.
- **Adjust on the invoice outside the system**: leaves no record beside the evidence and nothing a statement can reproduce; rejected.
- **Never close, always recompute**: a prune (ADR-0023), redaction or restore would silently change a month already billed; rejected.

## Consequences

- An invoice comes from one reviewed command, not hand-written SQL; spec 08 §K.2 points to it.
- `usage_records` gains `billing_basis` and `api_keys` gains `internal`; both default to the old behaviour, so existing rows and writers are unaffected.
- Both billing tables only grow; a wrong adjustment is answered by another adjustment.
- The integration guide states the UTC billing month and what a late Writing result costs.
