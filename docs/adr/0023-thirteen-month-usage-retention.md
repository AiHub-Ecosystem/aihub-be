# Thirteen-month usage retention

AIHUB retains every durable metering record for a rolling 13-calendar-month
window so operators can compare year-over-year usage without keeping an
unbounded billing evidence table. The `usage:prune` CLI is a thin operator
adapter over a metering application service and Postgres port; it captures an
injectable UTC retention cutoff (calendar subtraction clamps month-end dates),
deletes records strictly older than it with a keyset-ordered
`(created_at, request_id)` batch in 1,000-row transactions, and reports stable
JSONL events with RFC3339 UTC timestamps, cutoff, batch size, batch count,
deleted count, status, and exit codes `0` (complete), `1` (operational or
partial failure), and `2` (invalid arguments). Records exactly at the cutoff
and future-dated records remain untouched.

The command runs once per deployment database at 02:30 UTC from the
corresponding application container, with one cron owner and no distributed
lock. Each batch uses `FOR UPDATE SKIP LOCKED` so accidental concurrent runs
skip rows already being pruned instead of waiting; a run that finds no rows is
still successful. It has no dry-run, confirmation flag, backup, or signal
handler side effect: the runbook requires a manual backup and preflight count
before the first run, while Postgres rolls back only the currently open batch
when a process is terminated. Partial progress exits non-zero and is safe to
rerun.

The command reads only the container's `DATABASE_URL`; clock and database URL
overrides are test seams, not operator arguments. Production and sandbox are
independent invocations, so one database can succeed while the other reports a
failure. Redis quota counters, idempotency cleanup, public contracts, and
records at or after the cutoff remain untouched. The existing BRIN index is
sufficient; this decision adds no schema, partitioning, or scheduler service.
Mocked application/port tests cover cutoff and batch behavior; a CLI process
test covers output and configuration failure without requiring Postgres.
