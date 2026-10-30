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
  Only an Organization API key attributes a request, so Customer Web traffic
  (Bearer, refresh cookie, BFF) is always unattributed.
- Unattributed requests are also counted by **caller kind**: how the matched
  route authenticates its caller, as the route registry declares it (`none`,
  `bearer`, `refresh-cookie`, `bff-client-secret`, `bff-api-key`, or `api-key`).
  An unattributed `api-key` request is one whose key was missing or refused.
  No credential is read to decide the kind.
- Counts are kept per UTC day in `public_api_major_usage` and
  `public_api_major_unattributed_usage`. They hold counts, Organization ids, a
  last-seen time, and caller kinds. They hold no API key, key hash, user
  identity, request body, or downstream response.
- Organization ids are never a Prometheus label. They appear only in this
  report, on operator stdout.

These counts support a sunset review; they are not billing evidence.

### How collection gaps show

Each process buffers counts in memory and writes them every 30 seconds, and a
pass is skipped while the previous one is still writing. Each process numbers
its writes. A write that fails is kept whole and sent again, under its number,
before newer counts. The database may have committed it before the connection
dropped, and `applied_batch` on the process row records the last number it
committed, so a retried write is added only once. Writes keep retrying while
the database refuses them. Each process has one live buffer capped at 16,384
distinct keys across attributed and unattributed samples; the flusher can also
hold one pending batch, so a process can retain up to 2 × 16,384 keys. At the
cap, samples that need a new key are dropped and counted by
`aihub_public_api_major_usage_samples_dropped_total`; samples for existing keys
continue to aggregate. The response hook only updates the in-process buffer;
database I/O stays in the scheduled flusher.

When a batch containing drops is successfully written, its dropped interval is
stored with the counts and collection record in the same transaction. Retries
use the same write number, so an interval is written only once. The report
marks every UTC day touched by a stored dropped interval inconclusive. Every
successful write also advances the process row in
`public_api_major_usage_coverage`, including writes with no counts.

On shutdown the process waits for a write in flight, then writes the rest and
records `stopped_cleanly_at`, giving up after 10 seconds. A process that dies,
or whose last write fails or times out, keeps `stopped_cleanly_at` empty.

There is a known limit: if the process dies after dropping samples but before
its next successful write persists the dropped interval, that interval is
lost. Coverage then relies on the existing 5-minute gap rule, so a burst above
the cap within one 30-second flush followed by a crash within 5 minutes can
still produce a `complete` verdict.

The report joins the process rows of an Environment. A stretch that no process
covers, longer than 5 minutes, makes every UTC day it touches inconclusive.
That stretch may be lost counts or an outage; the report cannot tell which, so
it never reads it as zero traffic. Days before the first process row, which
includes every day before this record existed, are inconclusive. A shorter
stretch is the bounded loss an unclean exit leaves while a replacement starts;
it keeps the verdict but is listed. The release being replaced during a deploy
keeps writing counts without a process row, while the new release covers the
same time.

## Running the report

Run it where the other Operator CLI commands run (see
`docs/operations/incident-response.md`), once per Environment, with
`AIHUB_RUNTIME_DATABASE_SCOPE` naming the Environment whose database
`DATABASE_URL` points to (`production` when unset). That Environment always gets
a coverage verdict, even when its database holds no row:

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
- `public_api_major_unattributed`: one per Environment, major, and caller
  kind, with `request_count` and `failure_count`. Unattributed counts written
  by a release that kept no caller kind appear as `unclassified`, so the kinds
  always add up to `unattributed_count`.
- `public_api_major_organization`: one per Organization that sent
  authenticated requests to that major, with `request_count` and
  `last_seen_at`.
- `public_api_major_coverage`: one per Environment, with `verdict`
  (`complete` or `inconclusive`), `inconclusive_days`, and `unclean_exits`
  (the UTC day of each process that stopped without writing its last counts).
  The verdict covers the requested window up to `as_of`.
- `public_api_major_window`: the window the report covers, `as_of`, and
  `coverage_start_day`, the earliest day with any count. A major with no
  recorded day in the window does not appear.

Every line comes from one database snapshot taken at `as_of`, so totals,
Organizations, caller kinds, and coverage agree with each other even while
processes keep writing.

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
   read each Environment's `public_api_major_coverage` line:
   - `complete`: the listed `unclean_exits` are bounded losses the policy
     accepts.
   - `inconclusive`: treat every Organization that Environment ever recorded
     for the major as an Active Consumer, and confirm each was contacted.
   - `coverage_start_day` alone does not prove the history is continuous; the
     verdict does.

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

There is no brownout before sunset. ADR-0127's "brownout deferred" update
(#1379) says when to reconsider it: an Active Consumer that answered neither
email by the 30-day step, or a customer that broke at sunset without seeing a
notice.

## Runtime retirement

`src/catalog/public-api-majors.ts` holds each major's lifecycle (ADR-0127's
"runtime retirement" update, #1367). A release retires a major on or after its
sunset date, never the clock, so the owner's sign-off in step 4 comes first.

1. **Successor release.** Add the successor major and give the old one a
   `sunset` naming the successor, the deprecation date, and a sunset date at
   least 12 months after the successor's `releasedAt`. Every response under the
   old major then carries `Deprecation`, `Sunset`, and a successor `Link`.
2. **Extension.** Move `sunsetAt` later. The release gate refuses a sunset that
   moves earlier.
3. **Retiring release.** After sign-off, set the major's `status` to `retired`,
   remove its routes, and run `pnpm generate:openapi`, which deletes
   `openapi/vN.json`. The gate refuses the removal before `sunsetAt`. From that
   deploy on, every request under the major gets `410 API_VERSION_RETIRED`.
   Those requests match no route, so adoption counting stops; the report keeps
   the history.
