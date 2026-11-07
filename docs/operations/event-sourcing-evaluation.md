# Event Sourcing evaluation

Status: evaluation completed. Verdict: **decline** — see
[ADR-0154](../adr/0154-decline-event-sourcing-for-organization-api-keys.md).
Issue [#1686](https://github.com/AiHub-Ecosystem/aihub-be/issues/1686)
records the decision; the CQRS pilot (#1682) is not a dependency, because its
scope is synchronous command/query buses only and adds no events, projections,
or read store.

## Candidate aggregate

Organization API-key lifecycle: create, rotate, revoke, plus the metadata list.
A key is the stream identity (one stream per API key); the organization is the
partition. This is the same slice the CQRS pilot routes, so the comparison has
a real anchor: any Event Sourcing story has to beat the model the pilot just
routed through.

## Comparison

| Concern                   | Current: PostgreSQL state + append-only audit + durable outbox                                                                                                                                                                               | Event sourcing (event store + projections)                                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transaction boundaries    | Mutation, audit event, and outbox row commit in one PostgreSQL transaction. The active-key limit and the "old key withdrawn, new key issued" rotation atomicity are invariants of that transaction; a failed audit write fails the mutation. | Write side gives an atomic append per stream. Invariants that span streams (active-key limit per organization) need either a single organization stream (coarsening the model) or outbox/consistency riders. Rotation atomicity across old and new streams is awkward for the same reason.                                                   |
| Replay / rebuild          | Rebuild means restoring the relational tables: PITR or backup restore. Audit events (24-month retention) are already queryable evidence of what happened, though they carry no credential material by design.                                | Replaying one stream reconstructs key state deterministically. But rebuild is only needed after data loss, where PITR is the production answer; event replay adds a recovery path without a evidenced recovery requirement over PITR.                                                                                                        |
| Read consistency          | Reads hit the relational tables: point-in-time, immediately consistent, no projection lag. The metadata list is one query.                                                                                                                   | Reads hit a projection: eventually consistent behind the write side, or served from snapshots plus tail. A second read model is a real consistency budget. No second read model exists today; nothing needs this trade.                                                                                                                      |
| Sensitive data            | API keys are stored as SHA-256 hashes in Postgres; organization audit events never carry keys, tokens, or their hashes; audit redaction is the only permitted modification.                                                                  | The event stream would have to carry the key hash to be the source of truth, which turns the event store into a credential store with 24-month retention and replay fan-out. The hash prohibition on the audit path does not bind the event store, but it is a useful warning: derived stores make credential-adjacent data harder to bound. |
| Event versioning          | Not applicable: relational schema migrations plus the existing reader-first / unrecognized-value discipline on stored payloads.                                                                                                              | Every historical event needs a version, an upcaster story, and a decision on whether replay uses the latest schema or the schema at append time. That is permanent tax per event type.                                                                                                                                                       |
| N-1 release compatibility | The current model rolls forward: one release writes, the same or older release reads, with unrecognized values skipped and reported.                                                                                                         | An event written by a newer release must be readable by the older release that replays it, or rebuild/rollback breaks. Versioning and unknown-event handling have to be solved before the first deploy, not after.                                                                                                                           |

## What the current model already gives

The append-only Organization Audit Event table covers the "what happened, when,
who" questions forensics asks, with an operator-facing read surface and a
redaction story. The durable email outbox covers at-least-once delivery. Neither
part needs one: their data are separate on purpose (an audit event is evidence,
not state, and carries no usable credential material). Event sourcing would
merge state, evidence, and transport into one store and pay for that merge with
versioning, projection lag, and credential-storage risk.

## Reopen triggers

Recorded so the decision can change on evidence, not on fashion:

1. A recovery or forensic requirement needs point-in-time reconstruction of key
   state that PITR demonstrably cannot supply.
2. A second read model appears for the same aggregate with a consistency
   requirement the relational read cannot meet.
3. Audit forensics needs to replay transitions (state at time T) instead of
   reading the events already recorded.

Until one trigger is observed, the relational source of truth remains
sufficient and CQRS-bus usage alone is not evidence for Event Sourcing.

## References

- [ADR-0035](../adr/0035-organization-audit-trail-boundary.md) — audit events are append-only, retained 24 months, and never carry credentials or hashes.
- [ADR-0074](../adr/0074-transactional-email-outbox.md) — durable transactional outbox for email delivery.
- [ADR-0040](../adr/0040-organization-audit-read-boundary.md) — organization audit read boundary.
- Issue [#1682](https://github.com/AiHub-Ecosystem/aihub-be/issues/1682) — CQRS pilot scope: synchronous buses, no events or projections.
