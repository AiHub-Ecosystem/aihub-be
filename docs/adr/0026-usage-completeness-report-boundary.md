# ADR-0026: CLI boundary for usage completeness reporting

- Status: Accepted
- Related issues: #54, #56, #57

AIHUB needs an operator-facing view of missing provider usage without making
the customer request path, the public API, or durable metering evidence
depend on the report. The current runtime has no Prometheus/Grafana alerting
implementation, while the accepted #54 contract requires an independently
runnable command with stable structured output. An older observability draft
describes a future one-hour metric alert; this decision records the first
implementation boundary without removing that future path.

## Decision

The first completeness report is a read-only `usage:report` CLI command. It
runs once per deployment database, uses an explicit half-open UTC window
`[from, to)`, and accepts only ISO-8601 timestamps with a `Z` offset. The
window must satisfy `from < to`, `to` cannot be in the future, and `from` must
remain inside the retained 13-calendar-month history. The hourly cron
invocation uses the UTC hour that just ended; operators can rerun any retained
window explicitly.

The report aggregates globally for that database and groups by operation. An
operation is eligible only when its catalogued downstream has an enabled
usage-reporting declaration. Disabled operations are omitted from operation
rows and excluded from every denominator; the summary makes a zero eligible
set visible. Every eligible operation is emitted, including one with no
traffic in the selected window.

The denominator is the count of durable records where:

- `outcome = 'success'`;
- `billable_requests = 1`, which excludes successful idempotency replays that
  did not make a downstream model call; and
- the operation is model-backed and reporting-eligible.

The numerator is the subset whose persisted `metering_status` is
`'missing_usage'`. The report trusts the finalized status rather than
recomputing token validity from nullable columns. Successful
`quota_unverified` records remain in the denominator; quota uncertainty is a
separate signal and must not be relabelled as a telemetry failure.

The application owns a report-specific read port and the infrastructure
adapter returns one validated snapshot grouped by operation. The adapter uses
one SQL query, not one query per operation. The command never writes Postgres,
Redis, or metering records and never estimates or rewrites usage.

Each successful run emits deterministic JSONL sorted by operation, followed
by a summary line. It does not include a run timestamp so the same evidence
and window produce the same output. `incomplete_percent` is a display number
rounded to two decimal places; alert comparison uses integer arithmetic:
`missing_count * 100 > successful_count`.

```json
{"event":"usage_report_operation","window_from":"2026-09-20T12:00:00.000Z","window_to":"2026-09-20T13:00:00.000Z","operation":"speaking.grading","downstream":"ai-speaking","successful_count":100,"missing_usage_count":0,"incomplete_percent":0,"status":"healthy"}
{"event":"usage_report_operation","window_from":"2026-09-20T12:00:00.000Z","window_to":"2026-09-20T13:00:00.000Z","operation":"speaking.grading-json","downstream":"ai-speaking","successful_count":0,"missing_usage_count":0,"incomplete_percent":0,"status":"healthy"}
{"event":"usage_report_summary","window_from":"2026-09-20T12:00:00.000Z","window_to":"2026-09-20T13:00:00.000Z","eligible_operations":2,"eligible_requests":100,"alert_operations":0,"status":"healthy"}
```

An operation is `alert` only when its rate is strictly above 1%; exactly 1%
and a zero denominator are healthy. The summary is `alert` when at least one
operation is alert. An alert is an operator signal and keeps exit code `0`.
Invalid arguments use exit code `2`; configuration, Postgres, or invalid
snapshot failures emit one safe `usage_report_failed` event and use exit code
`1`. Raw database errors, connection strings, credentials, request bodies,
and downstream responses never appear in output.

Changing a downstream declaration affects new metering records only. The
report does not persist declaration history or backfill records; operators
must start a report window at or after a reporting activation when comparing
the service's completeness rate. A window crossing an activation boundary is
not comparable and is documented as such in the runbook.

## Consequences

- The existing cron/monitor path can alert on the summary status, non-zero
  exit, and missed runs without a new scheduler or alert backend.
- After this change is deployed, AI Speaking is enabled and contributes two
  eligible operations; AI Writing remains disabled pending production
  verification. With no Speaking traffic, the report emits two zero-count
  healthy rows rather than a zero eligible-operation set.
- The report is intentionally global per deployment database; organization
  breakdown and historical declaration timelines are outside #54.
- A future Prometheus/Grafana implementation may consume the same policy and
  numerator/denominator semantics without changing this CLI contract.
