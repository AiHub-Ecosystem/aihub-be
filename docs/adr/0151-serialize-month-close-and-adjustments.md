# ADR-0151: Serialize month close with adjustments and read statements from one snapshot

- Status: Accepted
- Date: 2026-11-05
- Related issue: [#999](https://github.com/AiHub-Ecosystem/aihub-be/issues/999)
- Amends: [ADR-0097](0097-billing-statements-adjustments-and-closed-months.md) for what happens when an adjustment meets a month close

## Context

ADR-0097 accepted that an adjustment racing a month close can commit after the
close read its totals, and that the next statement reports the difference.
Issue #999 asks for the stricter invariant: an adjustment is either in the
closed totals or refused because the month is closed. Local PostgreSQL probes on
the issue showed two gaps: the adjustment's closed-month check and insert ran in
a separate transaction from the close, and a statement read usage, adjustments,
and closures with three independent queries, so it could report a total that
never existed in a consistent state.

## Decision

**One lock per Organization and month.** A close and an adjustment each take
`pg_advisory_xact_lock(hashtextextended('<organization>:billing-month:<YYYY-MM>', 0))`
as their first statement. The close holds it from before it reads totals until
its closure rows commit. The adjustment holds it across its closed-month check
and insert. Both run `READ COMMITTED`, so each statement after the lock sees
what the previous holder committed; a `REPEATABLE READ` transaction would fix
its snapshot at the lock statement, before the wait.

**Close is per Organization.** `billing:statement --close true` finds the open
Organizations in one snapshot, then closes each in its own transaction under its
own lock, rereading that Organization's totals after the lock. A run interrupted
halfway leaves the finished Organizations closed and closes the rest on the
next run, which skips a closed one. When a close fails partway, the command
prints `billing_statement_failed` with `closed_organizations` and
`failed_organization` (Organization ids only, no database text), stops at the
first failure, and exits non-zero with the same error code. If every close
committed and only the final statement read failed, `failed_organization` is
absent. Later Organizations are not attempted. Re-running it is safe ([#1618](https://github.com/AiHub-Ecosystem/aihub-be/issues/1618)). An
Organization that first appears after the list was read is closed by the next
run.

**A statement reads one snapshot.** Usage, adjustments, and closures are read in
one `REPEATABLE READ` transaction. The default isolation level gives each
statement a fresh snapshot and does not guarantee this.

ADR-0097's sentence that an adjustment racing a close lands as a later
difference no longer applies. A difference still appears when evidence changes
after a close, such as a prune, a redaction, or a restore.

## Considered options

- **`SERIALIZABLE` for both transactions**: also prevents the race, but detects
  conflicts only among transactions that all run at that level, so close and
  adjustment would both switch and each need a bounded retry on SQLSTATE
  `40001` (Prisma `P2034`). The code maps that error and has no retry loop. A
  lock waits instead of aborting, matches the other control-plane invariants,
  and stays bounded by the pool's `lock_timeout` and the transaction timeout.
- **One lock for the whole month, or for all Organizations of a run**: simpler
  for an all-Organizations close, but an adjustment for one Organization would
  wait on every other Organization's close.

## Consequences

- The lock does not serialize usage writers. A usage record that commits after a
  close read its totals still shows as a difference on the next statement;
  lateness and the watermark belong to [#759](https://github.com/AiHub-Ecosystem/aihub-be/issues/759).
- An adjustment waits for a close in flight, up to its transaction timeout, and
  fails with the database-failure code if the wait exceeds it.
- A close reads one Organization's usage under its lock with a longer
  transaction timeout than a control-plane write.
- Database-lane specs overlap a close and an adjustment in both orders and read a
  statement across a concurrent change.
