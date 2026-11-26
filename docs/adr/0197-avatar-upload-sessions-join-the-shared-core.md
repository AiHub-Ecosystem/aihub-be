# ADR-0197: Avatar upload sessions join the shared core

- Status: Accepted
- Date: 2026-11-26
- Amends: [ADR-0068](0068-avatar-is-a-user-account-owned-asset.md) (decision 5, decision 6, and Update item 6), [ADR-0196](0196-one-upload-session-core-serves-avatar-speaking-and-writing.md) (Avatar migration order)
- Related issue: [#2052](https://github.com/AiHub-Ecosystem/aihub-be/issues/2052)
- Follows: [design spec](../superpowers/specs/2026-11-26-avatar-upload-session-core-design.md)

## Context

ADR-0196 chose one upload-session core for Avatar, Speaking, and Writing. ADR-0068 decision 5 said "No upload intent is stored between the two calls" and Update item 6 said grants need no sweep. A shared lifecycle cannot own creation, transitions, and sweep without a durable session record.

## Decision

Decision 5, decision 6, and Update item 6 of ADR-0068 are amended: the existing grant row is Avatar's durable upload-session record. It is consumed on completion and swept when it never completes. The one-Avatar-per-account record remains conditional on the Avatar the caller read, and ADR-0195 still orders commit before old-object cleanup.

## Considered options

- **Create a separate Avatar intent table.** Rejected: ADR-0196 says migrate, not add a second durable record for one session.
- **Keep grant rows ephemeral and rely only on bucket listings.** Rejected: the core cannot own the lifecycle without a durable session record.

## Consequences

- A grant is durable lifecycle state; a failed completion is sweepable.
- ADR-0068 keeps its original text; this record is the authority for the amended clauses.
