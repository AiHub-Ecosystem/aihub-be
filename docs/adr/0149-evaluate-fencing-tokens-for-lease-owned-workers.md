# ADR-0149: Evaluate PostgreSQL fencing for lease-owned work

- Status: Proposed — evaluation recommends deferring production adoption until a concrete worker and protected resource are selected.
- Date: 2026-11-05
- Related: [#1055](https://github.com/AiHub-Ecosystem/aihub-be/issues/1055), [ADR-0116](0116-post-result-grading-completion-timing.md), [ADR-0132](0132-identity-config-writes-carry-an-optional-precondition.md), [ADR-0147](0147-graded-pipeline-engine-owns-execution-lifecycle.md)

## Context

Issue #1055 asks whether an expired lease can let a paused worker write after a
new owner has taken over. A lease alone cannot stop a paused client from
resuming with stale work; the protected storage must reject stale tokens
([Kleppmann, “How to do distributed locking”](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)).

The current code has no shared lock service for batch grading, audio
processing, or billing reconciliation. Grading's Redis lease is a concurrency
permit. Writing idempotency completion is guarded by the durable request ID in
PostgreSQL. The email outbox uses a PostgreSQL row lease. These have different
lifecycles and write boundaries, so a common production integration would
change behavior without a selected workload to protect.

## Decision

Keep this evaluation out of production paths. The database-lane prototype uses
a PostgreSQL row as the durable lease and per-resource token counter. An
atomic `INSERT ... ON CONFLICT ... DO UPDATE` grants an expired lease and
increments its `bigint` token. PostgreSQL time decides lease expiry. The
prototype keeps the lease row as the high-water mark; deleting or recreating
it would permit token reuse.

Each protected mutation must atomically persist its state and newer token:

```sql
UPDATE protected_records
SET value = $2, fencing_token = $3
WHERE resource_id = $1 AND fencing_token < $3;
```

Zero updated rows means the write was stale or the resource was absent; it
must not be reported as a successful mutation. The prototype pauses worker A
for five seconds while worker B takes over and writes token 2. When A resumes,
its token 1 write affects zero rows. A then detects the takeover, aborts local
work, joins its settlement, and starts no later local side effect.

This demonstrates the storage guard after a newer token reaches the
resource. It does not prove rejection in the interval after a newer lease is
granted but before its token is recorded on the protected resource. A
production design must close that interval by atomically advancing the
resource fence during lease grant, or by checking the current lease token and
updating the resource in one PostgreSQL transaction. Every protected write
must use that transaction boundary.

Prisma OCC can express a resource guard with an ordinary `BigInt` revision
field and a conditional `updateMany`; the caller must check `count === 1`.
Prisma 7's OCC example uses a normal `version` field, not a special version
annotation ([Prisma 7 transactions and OCC](https://docs.prisma.io/docs/orm/v7/prisma-client/queries/transactions)).
OCC detects a conflicting revision; it does not allocate a distributed
fencing token or make the newest lease generation visible to the resource.
The existing identity-configuration `revision` is a content revision, not a
worker ownership token.

When a worker learns that renewal failed or ownership changed, it should abort
cooperative local work and await its settlement before starting another side
effect. This is best-effort cancellation and cost containment. The storage
guard remains the stale-write guarantee; an already-sent provider request is
not claimed stopped without provider evidence.

Use PostgreSQL for any future correctness token unless its failover and
restore behavior proves another store cannot reissue an older token. Redis
remains the ephemeral counter/protection store described in [04 — Redis](../superpowers/specs/2026-09-07-aihub/04-redis.md). A production change also needs the target resource lifecycle, token retention, transaction boundary, and rollout/rollback behavior specified before an adoption issue is filed.

## Consequences

The prototype and five-second pause test run only in `test/db/fencing/`; no
production migration or worker behavior changes. Keep the issue's production
integration deferred. Re-evaluate when a concrete multi-process worker relies
on an expiring lease to authorize writes to a named durable resource. Any
adopted implementation must protect every mutation, retain token history for
the resource lifetime, and treat cancellation as a secondary guard.
