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

## Retiring a major

ADR-0127 keeps a superseded major available for at least 12 months. Its
"retirement evidence" update (#1376) defines the evidence and sign-off this
procedure follows. Counts are not pruned automatically; each row is one
Organization, major, and day, so the table grows slowly and a 12-month review
needs no separate archive.

The report shows that every Active Consumer was found. It does not have to
prove that traffic stopped. An **Active Consumer** is an Organization with at
least one authenticated request, successful or failed, to the old major in
either Environment during the 90 days before sunset.

Run every report once per Environment. Keep the Organization lists and the
outreach log private with the report output. The public retirement issue
carries only aggregate figures, because the repository is public.

1. **Successor release.** Publish the sunset date (at least 12 months out) with
   the release; the `Deprecation` and `Sunset` headers (#1362) carry it to
   every caller. Open a public retirement issue for the old major. Run the
   report from `coverage_start_day` and email the active `owner` members of
   every Organization it lists.
2. **90 days before sunset.** Run the report over the last 90 days. Email the
   active `owner` members of every Active Consumer.
3. **30 days before sunset.** Repeat step 2.
4. **7 days before sunset.** Run the final report over the last 90 days and
   decide per Environment whether its evidence is complete:
   - Bounded loss from a process that exited uncleanly (at most one flush
     interval each) is acceptable when the report shows it.
   - Any longer gap makes that Environment's evidence inconclusive: repeated
     failed writes, a day with no successful write while the major was served,
     or a failed final write. Treat every Organization that Environment ever
     recorded for the major as an Active Consumer, and confirm each was
     contacted.
   - `coverage_start_day` alone does not prove the history is continuous.

   Explain the unattributed requests by caller kind. Confirm that Customer Web
   has moved to the successor major, and record the rest in the sign-off. Then
   post the aggregate figures on the retirement issue for each Environment:
   Active Consumer count, request totals, unattributed totals by caller kind,
   and inconclusive days. The Public API owner signs off there.

5. **Extension.** If a contacted Active Consumer says it is still migrating,
   the owner may extend support by at most 3 months per decision. Publish the
   revised date in the `Sunset` header and the documentation, then restart from
   step 2 for the new date. An Active Consumer that does not reply after both
   reminders is not a reason to extend.
6. **Sunset.** Requests to the retired major are answered with `410 Gone`
   (#1367) and are no longer counted. The report keeps the history.

Until #1389 lands, the report cannot show gaps or break unattributed requests
down by caller kind. Until then, treat every Environment's evidence as
inconclusive.
