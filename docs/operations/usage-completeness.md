# Usage completeness report

This runbook describes the read-only `usage:report` command for detecting
missing provider usage evidence. It measures reporting health from durable
`usage_records`; it never blocks customer requests, estimates tokens, rewrites
records, or changes quota state.

## Schedule and scope

Run once per hour at **05 minutes past the hour**, separately for each
deployment database. The report covers the UTC hour that just ended. Production
and sandbox are independent runs and have independent missed-run alerts.

The cron owner supplies explicit timestamps so the run is deterministic:

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  exec -T app node scripts/runtime-entrypoint.mjs scripts/cli.mjs usage:report \
  --from 2026-09-20T12:00:00.000Z \
  --to 2026-09-20T13:00:00.000Z

docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  --profile sandbox exec -T app-sandbox node scripts/runtime-entrypoint.mjs scripts/cli.mjs usage:report \
  --from 2026-09-20T12:00:00.000Z \
  --to 2026-09-20T13:00:00.000Z
```

The production image has no `pnpm`, and `docker compose exec` skips the
container entrypoint that loads the runtime secrets, so the command goes
through `scripts/runtime-entrypoint.mjs`, which loads them and then hands the
rest of the arguments to the CLI ([`deploy-vps.md`](deploy-vps.md)).

The window is half-open: `created_at >= from AND created_at < to`. Arguments
must be ISO-8601 UTC timestamps with `Z`, `from < to`, `to <= now`, and `from`
inside the retained 13-calendar-month history. A rerun uses the same explicit
window and is read-only.

## Eligibility and calculation

The report runs against one database and aggregates globally by operation. It
uses the code-owned usage-reporting declaration from the metering application:

- only model-backed operations whose downstream declaration is enabled are
  reporting-eligible;
- disabled operations are excluded from the denominator and operation rows;
- every eligible operation still receives a zero-count healthy row when there
  is no traffic;
- successful idempotency replays are excluded because their durable
  `billable_requests` value is `0` and they did not call a model.

For each eligible operation:

```text
successful_count = count(outcome = 'success' AND billable_requests = 1)
missing_usage_count = count(the same records where metering_status = 'missing_usage')
```

`quota_unverified` records remain in `successful_count`; quota uncertainty is
not a missing-usage classification. The report trusts the persisted
`metering_status` and never recomputes or fabricates token values.

The alert comparison is exact integer arithmetic:

```text
alert when missing_usage_count * 100 > successful_count
```

Exactly 1% is healthy. A zero denominator is healthy with a displayed rate of
`0`. The summary is alert when any operation is alert.

## Output

Successful output is deterministic JSONL sorted by `operation`; the summary is
the final line. It contains no `generated_at` field so rerunning the same
window against unchanged evidence produces the same lines.

```json
{"event":"usage_report_operation","window_from":"2026-09-20T12:00:00.000Z","window_to":"2026-09-20T13:00:00.000Z","operation":"writing.task1.grade","downstream":"ai-writing","successful_count":100,"missing_usage_count":2,"incomplete_percent":2,"status":"alert"}
{"event":"usage_report_summary","window_from":"2026-09-20T12:00:00.000Z","window_to":"2026-09-20T13:00:00.000Z","eligible_operations":1,"eligible_requests":100,"alert_operations":1,"status":"alert"}
```

`incomplete_percent` is a number rounded to two decimal places for display;
the threshold is never evaluated from that rounded value. With no eligible
operations, the command emits the summary with `eligible_operations: 0`,
`eligible_requests: 0`, `alert_operations: 0`, and `status: "healthy"`.

## Exit codes and failure handling

| Exit code | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| `0`       | Complete report, whether healthy or alert                           |
| `1`       | Missing configuration, Postgres failure, or invalid report snapshot |
| `2`       | Invalid arguments or invalid UTC window                             |

After the window is parsed, a configuration/database/snapshot failure emits
one safe event:

```json
{
  "event": "usage_report_failed",
  "window_from": "2026-09-20T12:00:00.000Z",
  "window_to": "2026-09-20T13:00:00.000Z",
  "status": "failed",
  "error_code": "USAGE_REPORT_DATABASE_FAILURE"
}
```

The command reads one complete Postgres snapshot before emitting operation
rows. It emits no partial success rows after a failed read or invalid snapshot.
The error codes are stable: `USAGE_REPORT_INVALID_WINDOW`,
`USAGE_REPORT_CONFIGURATION_MISSING`, `USAGE_REPORT_DATABASE_FAILURE`, and
`USAGE_REPORT_SNAPSHOT_INVALID`. Never print raw SQL, database errors,
connection strings, credentials, request bodies, assertions, or downstream
responses.

The cron monitor must alert on:

1. a summary with `status: "alert"`;
2. a non-zero exit; and
3. a missed hourly run for either deployment database.

An alert status is not a command failure. Fix provider/reporting coordination
or the infrastructure dependency as appropriate, then rerun the same window.

## Declaration activation

Current Writing and Speaking declarations are disabled because their provider
contracts do not yet require usage telemetry. Their traffic is intentionally
excluded and a zero eligible denominator is healthy. When #57 contract and
production evidence enable one service, start reporting windows at or after
that activation. A report window crossing the activation boundary is not
comparable; no historical record is backfilled or rewritten.

## Verification

Use fake application/repository ports for tests. No default test calls real
Postgres, Redis, downstream services, cron hosts, or production endpoints.
Before handoff, run:

```sh
pnpm verify
```
