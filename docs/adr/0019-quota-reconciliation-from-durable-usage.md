# ADR-0019: Reconcile quota counters from durable usage evidence

- Status: Accepted
- Related issue: #53
- Related issue: #51

AIHUB treats Redis quota counters as a fast admission heuristic and
`usage_records` as the durable source of billable request truth. A nightly
`quota:reconcile` CLI command therefore reads every quota-bearing
organization's billable requests for one UTC calendar month and overwrites
the matching Redis key with the durable total and a 40-day TTL. The command
defaults to the current UTC month and accepts an explicit `--month YYYY-MM`
within the retained 13-month history for an operator rerun.

The command reads one Postgres snapshot before writing Redis, counts only
successful `billable_requests` (including successful `quota_unverified`
records), writes keys best-effort, and exits non-zero on configuration or
infrastructure failure. It reports over-quota organizations without changing
their policy or keys. Cross-organization atomicity and distributed locking
are deliberately omitted: a partial run is visible and safely rerunnable,
while `usage_records` remains authoritative during the consistency window.
