# ADR-0154: Decline Event Sourcing for Organization API Keys

- Status: Accepted
- Date: 2026-11-07
- Related: [#1686](https://github.com/AiHub-Ecosystem/aihub-be/issues/1686), [#1682](https://github.com/AiHub-Ecosystem/aihub-be/issues/1682), [event sourcing evaluation](../operations/event-sourcing-evaluation.md)

## Context

After the Organization API-key CQRS pilot (#1682), #1686 asks whether Event Sourcing solves a concrete AIHUB requirement. The comparison runs on one candidate aggregate — the Organization API-key lifecycle (create, rotate, revoke, metadata list), one stream per key, the organization as partition — against the current PostgreSQL state, the append-only Organization Audit Event table (ADR-0035, 24-month retention, no credential material), and the durable email outbox (ADR-0074).

The evaluation is complete in [docs/operations/event-sourcing-evaluation.md](../operations/event-sourcing-evaluation.md). The pilot's synchronous-bus scope creates no Event Sourcing evidence: it adds no events, projections, or read store, so #1686 does not wait on #1682.

## Decision

**Decline** Event Sourcing for the Organization API-key lifecycle. The relational source of truth remains sufficient: mutation, audit event, and outbox row commit in one transaction, reads are immediately consistent, and no evidenced requirement needs replay over PITR. Using a CQRS bus is not, by itself, evidence for Event Sourcing.

## Reopen triggers

Revisit — with a new issue and a comparison against the model in force — only when one is observed:

1. A recovery or forensic requirement needs point-in-time reconstruction of key state that PITR demonstrably cannot supply.
2. A second read model appears for the same aggregate with a consistency requirement the relational read cannot meet.
3. Audit forensics needs to replay transitions instead of reading the events already recorded.

## Consequences

- No event store, no projections, no event versioning tax.
- If a trigger fires, the next evaluation starts from the comparison in this record and scopes any adoption to one aggregate in a separate implementation issue.
