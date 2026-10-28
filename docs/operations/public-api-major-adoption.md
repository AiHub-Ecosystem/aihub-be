# Public API major adoption report

This runbook describes the read-only `usage:major-report` command. ADR-0127
requires AIHUB to review customer traffic and contact the affected
Organizations before it retires a Public API major. The report shows who still
calls each major, from durable daily counts.

## What is counted

Every response to a matched `/vN/...` Public API route adds one request to the
day's row for its major, Environment, and Organization. A request counts as
failed when its outcome is not `success`, using the same outcome rule as the
Request Completion Event.

- Health probes, `/metrics`, `/docs`, `/openapi/*`, and paths that match no
  route are never counted. After a major's routes are removed its requests are
  unmatched, so they stop being counted at retirement.
- A request that carries no authenticated Organization is counted under its
  major with no Organization. The report shows these as `unattributed_count`.
- Counts are kept per UTC day in `public_api_major_usage`. The table holds
  counts, Organization ids, and a last-seen time. It holds no API key, key
  hash, user identity, request body, or downstream response.
- Organization ids are never a Prometheus label. They appear only in this
  report, on operator stdout.

Each process buffers counts in memory and writes them every 30 seconds and
once more at shutdown. A crash loses at most the last interval of counts, and a
failed write is retried with the next one. These counts support a sunset
review; they are not billing evidence.

## Running the report

Run it where the other Operator CLI commands run (see
`docs/operations/incident-response.md`), once per Environment:

```sh
node scripts/cli/cli.mjs usage:major-report --from 2026-10-01 --to 2026-10-29
```

`--from` and `--to` are UTC days (`YYYY-MM-DD`). The window is half-open:
`usage_day >= from AND usage_day < to`. `from < to`, and `to` is at most
tomorrow, so today's counts are included. The command reads one database, so
Production and Sandbox are separate runs.

The output is JSONL:

- `public_api_major_total`: one per Environment and major, with
  `request_count`, `failure_count`, `unattributed_count`, and
  `organization_count`.
- `public_api_major_organization`: one per Organization that sent
  authenticated requests to that major, with `request_count` and
  `last_seen_at`.
- `public_api_major_window`: the window the report covers and
  `coverage_start_day`, the earliest day with any count. A window that starts
  before `coverage_start_day` is not fully covered. A major with no recorded
  day in the window does not appear.

A failure prints `public_api_major_report_failed` with a fixed `error_code`
and exits non-zero. A malformed window is a usage error and prints nothing on
stdout.

## Using it with the sunset policy

ADR-0127 keeps a superseded major available for at least 12 months and
requires a review of customer traffic before sunset. Counts are not pruned
automatically; each row is one Organization, major, and day, so the table grows
slowly and a 12-month review needs no separate archive.

1. At the successor release, record `coverage_start_day` for the old major.
2. Before the sunset date, run the report over the whole support window for
   each Environment. Contact every Organization listed for the old major, using
   `last_seen_at` to tell active callers from ones that stopped.
3. If customers are still migrating, an owner decision may extend support;
   publish the revised date, then keep reporting until it passes.
4. After sunset, requests to the retired major are answered with `410 Gone` and
   no longer counted. The report keeps the history for the final review.
