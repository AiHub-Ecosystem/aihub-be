# Quota reconciliation

This runbook describes the nightly command that restores Redis quota counters
from the durable `usage_records` table. Redis is only an admission heuristic;
the usage table is the billing and audit source of truth.

Usage retention is a separate 02:30 UTC maintenance job; see
[usage retention](./usage-retention.md). It must not be folded into this
reconciliation command.

## Schedule

Run the command once per day at 02:00 UTC from the AIHUB application
container:

```sh
pnpm cli quota:reconcile
```

The cron owner must alert on a non-zero exit and on a missed run. A missed run
does not produce a failure line, so the monitor should use the absence of a
recent successful run as its dead-man's-switch signal.

## What it reconciles

One command run captures one UTC month boundary and selects every organization
whose `monthly_request_quota` is not `null`, including suspended organizations.
Organizations with no billable usage receive a counter value of `0`.

The billable total is:

```sql
SUM(billable_requests) FILTER (WHERE outcome = 'success')
```

The window is half-open: `created_at >= month_start` and
`created_at < next_month_start`. Successful records marked
`quota_unverified` are still billable evidence and are included. Failed or
non-billable records are not counted.

For each organization, the command overwrites:

```text
aihub:v1:quota:<organization_id>:<YYYY-MM>
```

with the durable total and a 40-day TTL. Organizations without a quota are
skipped because they do not create quota counters.

## Rerun and backfill

The default target is the current UTC calendar month. An operator may rerun a
retained month explicitly:

```sh
pnpm cli quota:reconcile --month 2026-09
```

`--month` must be strict `YYYY-MM`, cannot name a future month, and is limited
to the current month plus the 12 preceding retained calendar months. Reruns
are idempotent: the same Postgres evidence produces the same counter values.

## Output and exit codes

Successful key writes emit JSON lines to stdout. Each organization line has
the following shape:

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

The final summary reports `reconciled`, `over_quota`, and `failed` counts:

```json
{
  "event": "quota_reconcile_summary",
  "month": "2026-09",
  "reconciled": 1,
  "over_quota": 0,
  "failed": 0
}
```

An organization whose durable count is strictly greater than its quota is
reported with `over_quota: true` and `excess` set to the difference. Being
over quota does not make the command fail; it is an operator signal, not an
automatic policy mutation.

| Exit code | Meaning                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `0`       | All selected keys were written; over-quota organizations may be reported. |
| `1`       | Postgres, Redis, configuration, or write failure.                         |
| `2`       | Invalid command arguments, including an invalid `--month`.                |

## Failure handling

The command validates its configuration and reads the complete Postgres
snapshot before writing any Redis key. A database or configuration failure
therefore causes no Redis mutation. Redis writes happen sequentially; if Redis
fails after earlier keys were written, the run stops, exits `1`, and reports
the organization at which it stopped. Do not roll back the keys already
written. Fix the dependency and rerun the same month; the rerun is the repair.

Do not run overlapping cron owners. No distributed lock is used. A live
request or a second run can race with an overwrite; the next reconciliation
run repairs the heuristic, while `usage_records` remains authoritative during
that consistency window.

When an organization is reported over quota, inspect the durable records and
the Redis outage/run logs. Do not automatically disable API keys, change the
quota, or enable `hard_stop_on_quota`; those are deliberate operator actions.

## Safety and verification

Output may contain organization IDs and aggregate counts only. Never log API
keys, tokens, assertions, request bodies, essays, connection strings, or raw
Redis/Postgres errors.

Run the focused CLI/reconciliation tests while iterating, then run:

```sh
pnpm verify
```
