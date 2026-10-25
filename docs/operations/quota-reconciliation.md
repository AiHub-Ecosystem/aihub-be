# Quota reconciliation

This runbook describes the nightly command that restores Redis quota counters
from the durable `usage_records` table. Redis is only an admission heuristic;
the usage table is the billing and audit source of truth.

Usage retention is a separate 02:30 UTC maintenance job; see
[usage retention](./usage-retention.md). It must not be folded into this
reconciliation command.

## Schedule

The CD-managed scheduled wrapper runs this command in the active Production and
Sandbox services once per day at 02:00 UTC. Run it manually through the same
wrapper so it gets the 15-minute per-deployment deadline, same-job lock, and
result logging:

```sh
./scripts/ops/host-jobs/host-scheduled-job.sh quota
```

The wrapper uses a nonblocking same-job lock and a host-wide lock shared by all
scheduled job types. A second `quota` invocation logs
`skipped reason=already_running`; if a different job is active, `quota` logs
`deferred reason=host_job_active` and exits non-zero so the operator can rerun
it. See [`deploy-vps.md`](deploy-vps.md) for the cross-job policy.

The wrapper appends a summary or bounded failure stderr to
`~/aihub-ops-job.log`; Prometheus alerts on an attention summary, a non-zero
exit, and a missed healthy run. An attention result means the Redis value did
not match the durable count before the command repaired it.

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
retained month through the host wrapper, preserving the per-deployment deadline,
same-job lock, and result log:

```sh
./scripts/ops/host-jobs/host-scheduled-job.sh quota --month 2026-09
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

The final summary reports how many organizations and request units differed
before the overwrite. Any positive `drift_requests` value is the stated
attention threshold; a missing Redis key is counted as zero before comparison.
The exact comparison happens before each overwrite, so a small difference can
also include requests still in flight during the run.

```json
{
  "event": "quota_reconcile_summary",
  "month": "2026-09",
  "reconciled": 1,
  "over_quota": 0,
  "drifted_organizations": 1,
  "drift_requests": 42,
  "status": "attention",
  "failed": 0
}
```

An organization whose durable count is strictly greater than its quota is
reported with `over_quota: true` and `excess` set to the difference. The
summary's `status` is `attention` when `drift_requests > 0` or
`over_quota > 0`, otherwise `healthy`. Any nonzero repaired difference or any
strict over-quota organization needs operator attention; over-quota policy is
never changed automatically.

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

Do not run overlapping cron owners. The host wrapper serializes all scheduled
job types on this VPS with a local host-wide lock; direct CLI runs or runs from
another host are not covered by a distributed lock. A live request or a second
run can race with an overwrite; the next reconciliation run repairs the
heuristic, while `usage_records` remains authoritative during that consistency
window.

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
