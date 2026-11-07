# ADR-0007: Postgres-backed idempotency without distributed locks

- Status: Accepted (retroactive record)
- Date: decided 2026-09-07 in the implementation specification suite; file written 2026-11-07

## Context

Grading requests may be retried by clients and by the gateway itself. Double
token charges are unacceptable; a distributed lock service (Redis lock,
Redlock) would add a coordination failure mode to solve a race that one
database already solves.

## Decision

Idempotency records live in Postgres; the race is resolved with a primary-key
conflict clause, not a lock
([03-database §E.4](../superpowers/specs/2026-09-07-aihub/03-database.md)):

```sql
INSERT INTO idempotency_records (...)
ON CONFLICT (organization_id, operation, actor_scope, idempotency_key)
DO NOTHING
RETURNING request_id;
```

| Outcome                             | Handling                                                              |
| ----------------------------------- | --------------------------------------------------------------------- |
| Row returned                        | First requester → proceed                                             |
| Existing row, different fingerprint | `409 IDEMPOTENCY_CONFLICT`                                            |
| Existing row, `state=completed`     | Replay stored response with `Idempotent-Replay: true`                 |
| Existing row, `state=pending`       | `409`, retryable with a jittered 2–3 s hint; **do not block or wait** |
| Existing row, `state=failed`        | Permit retry                                                          |

Background execution prevents double token charges: a request whose response
deadline passes continues idempotently in the background rather than charging
a second attempt.

## Consequences

- No Redis lock, no Redlock, no lease renewal, no clock-skew class of bugs.
- "Do not block on pending" keeps connections free; waiting risks cascading
  starvation.
- The `request_fingerprint` is `sha256(canonical JSON body + actor)`, so a key
  reused with a different body is a conflict, not silent reuse.
- Implementation lives in `src/modules/idempotency/`
  (`postgres-idempotency.repository.ts`); Redis never stores idempotency
  records.
