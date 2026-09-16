# Spec: Nightly quota reconciliation (#53)

## Objective

Build an operator-facing `quota:reconcile` command that restores the Redis
quota counter from durable `usage_records` evidence. Redis is an admission
heuristic; Postgres is the authoritative billable request record. The command
must make quota drift visible and safely repairable without changing customer
requests, public contracts, or quota policy.

The operator can reconcile the current UTC calendar month or explicitly rerun
one of the 13 retained calendar months. A successful run produces the same
counter values when given the same durable evidence; an over-quota organization
is reported, never mutated automatically.

## Domain contract

- The target window is half-open: `created_at >= month_start` and
  `created_at < next_month_start`, both computed in UTC.
- The default target is the current UTC month. `--month YYYY-MM` may select the
  current month or one of the preceding 12 retained calendar months; future or
  older months are invalid.
- Select every organization whose `monthly_request_quota IS NOT NULL`,
  including suspended organizations. A selected organization with no matching
  usage receives a durable count of `0`; organizations with a `null` quota are
  skipped and do not create counters.
- The billable count is `SUM(billable_requests)` filtered by
  `outcome = 'success'`. Successful `quota_unverified` records remain billable
  evidence and are included. Failed and non-billable records are excluded;
  reconciliation never repairs an anomalous usage row.
- Redis keys use the gateway's canonical format:
  `aihub:v1:quota:<organization_id>:<YYYY-MM>`.
- Each selected key is overwritten with `SET` and a 40-day TTL, including a
  zero value. Overwrite is a dedicated reconciliation capability, separate
  from the hot-path read/increment capability.
- The command reads one complete Postgres snapshot before any Redis write, then
  writes keys sequentially. A Redis failure after earlier writes is a visible
  partial failure; earlier keys are not rolled back and the same month is
  rerun after the dependency is repaired.
- No distributed lock is used. A live request or overlapping run may race with
  an overwrite; the next reconciliation repairs the heuristic while
  `usage_records` remains authoritative.

## Tech Stack

- Node.js 22+ and the existing ESM CLI entry point.
- PostgreSQL via the repository's existing `pg` client boundary.
- Redis via the existing `ioredis` client and canonical quota key/TTL rules.
- No new runtime dependency, scheduler framework, database table, or public
  API surface.

## Commands

```sh
# Reconcile the current UTC calendar month.
pnpm cli quota:reconcile

# Explicitly rerun a retained UTC month.
pnpm cli quota:reconcile --month 2026-09

# Required verification before handoff.
pnpm verify
```

Exit codes follow the existing CLI convention: `0` means all selected keys
were written (over-quota results may be present), `1` means configuration,
Postgres, Redis, or write failure, and `2` means invalid arguments.

## Output contract

The command emits stable JSON lines in deterministic `organization_id` order.
Successful key writes use this shape:

```json
{
  "event": "quota_reconciled",
  "organization_id": "org_01J...",
  "month": "2026-09",
  "billable_count": 42,
  "quota": 100,
  "over_quota": false,
  "excess": 0
}
```

The completed run emits a final summary:

```json
{
  "event": "quota_reconcile_summary",
  "month": "2026-09",
  "reconciled": 1,
  "over_quota": 0,
  "failed": 0
}
```

An organization is over quota only when `billable_count > quota`; `excess` is
the strict difference. On a partial failure, the command emits a structured
failure line for the organization being processed, exits `1`, and does not
claim a successful run. Fatal output never includes raw exception messages,
connection strings, credentials, request bodies, or downstream responses.

## Project Structure

- `scripts/cli.mjs` — parses the command and options and composes the
  reconciliation use case; it remains the cron entry point for existing CLI
  commands.
- `src/modules/metering/application/` — owns the reconciliation use case and
  the narrow application ports for the organization snapshot and Redis
  overwrite capability.
- `src/modules/metering/infrastructure/` — implements the durable Postgres
  aggregate/query boundary.
- `src/modules/gateway/infrastructure/` — implements the canonical Redis quota
  overwrite using the existing Redis connection policy.
- Adjacent `*.spec.ts` files and CLI boundary tests — verify outcomes and
  effects through fakes, not private helper layout.
- `docs/operations/quota-reconciliation.md` — schedule, alerting, output, and
  recovery runbook.

## Code Style

Keep the calculation explicit, immutable, and safe at the boundary:

```ts
const overQuota = billableCount > quota;
const result = {
  organizationId,
  month,
  billableCount,
  quota,
  overQuota,
  excess: overQuota ? billableCount - quota : 0,
} as const;
```

Use repository conventions: `camelCase` in application objects,
`snake_case` only at SQL/JSON boundaries, readonly inputs, explicit UTC
boundaries, deterministic ordering, and safe integer validation. Keep the CLI
thin; it must not become a second domain model.

## Testing Strategy

- Test the command through its public CLI/application boundary with fake
  Postgres and Redis ports. No default test calls a real database, Redis
  instance, cron host, or VPS.
- Cover current-month default, explicit month validation, UTC rollover,
  half-open boundaries, 13-month history, zero counts, suspended and
  no-quota organizations, and deterministic ordering.
- Cover `SUM(billable_requests)` semantics, successful `quota_unverified`
  inclusion, failed/non-billable exclusion, strict over-quota reporting, and
  zero-denominator/empty selections.
- Cover `SET` with the canonical key and 40-day TTL, persistent fake state,
  idempotent reruns, database failure before writes, Redis failure between
  organizations, and the no-rollback partial-failure contract.
- Assert JSON output, exit codes, and that no policy, usage row, public
  response, or raw secret/error data is mutated or exposed.
- Finish with `pnpm verify` (lint, type-check, full Jest suite, architecture
  check, and OpenAPI validation).

## Boundaries

- **Always:** capture one UTC month boundary per run; validate the target
  month; read the full Postgres snapshot before Redis writes; write the
  canonical key with a 40-day TTL; report strict overages; keep reruns safe;
  preserve durable usage evidence; document cron and missed-run handling.
- **Ask first:** any schema/retention change, new dependency, scheduler or
  metrics backend, change to the JSONL/exit-code contract, or public API and
  OpenAPI change.
- **Never:** use Redis as billing truth; count failed work; fabricate usage;
  mutate quota, API-key, or organization policy automatically; add a
  distributed lock/reservation/rollback scheme; delete usage rows; log
  secrets or raw request/downstream data; call real infrastructure in tests.

## Success Criteria

- [ ] `pnpm cli quota:reconcile` recomputes every quota-bearing organization's
      current-month billable count from `usage_records` and overwrites its
      canonical Redis counter.
- [ ] `--month YYYY-MM` uses the same UTC boundaries and key format as #51 and
      rejects future/out-of-retention months.
- [ ] Only successful billable units are counted; `quota_unverified` successes
      are included and failed/non-billable records are not.
- [ ] Null-quota organizations are skipped; zero-usage organizations receive a
      zero counter; strict overages are reported distinctly.
- [ ] Redis failure is visible with a non-zero exit and partial scope; the
      command never claims completion or silently resets failed keys.
- [ ] Repeating a run with the same evidence is idempotent.
- [ ] The operations runbook documents the 02:00 UTC cron, output, alerting,
      over-quota response, partial failure, and manual rerun.
- [ ] `pnpm verify` passes.

## Open Questions

None. The scope, UTC semantics, count definition, organization selection,
overwrite/TTL behavior, partial-failure policy, output contract, scheduling,
documentation, and test boundaries were confirmed during the Issue #53 grill.

Missing-usage alerting and usage-record retention are separate follow-up
issues (#54 and #55); the existing idempotency cleanup command is unchanged.
