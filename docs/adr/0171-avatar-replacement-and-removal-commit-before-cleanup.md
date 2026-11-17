# ADR-0171: Avatar replacement and removal commit before object cleanup

- Status: Accepted
- Date: 2026-11-16
- Related issue: [#509](https://github.com/AiHub-Ecosystem/aihub-be/issues/509)
- Amends: [ADR-0068](0068-avatar-is-a-user-account-owned-asset.md), decision 6

## Context

Deleting the old object before changing `user_avatars` can leave a committed row
pointing to missing bytes if Postgres fails or the process stops after deletion.
The Avatar orphan sweep already removes old, unreferenced final objects.

## Decision

Replacement publishes and verifies the candidate, commits the conditional row
replacement and audit event, then deletes the previous object. Removal commits
the conditional row removal and audit event before deleting its object. A
failed cleanup leaves only an unreferenced object for the existing sweep.

Cleanup rechecks the exact object key while holding the account lock immediately
before deletion. This prevents a stale completion from deleting an object that
a later retry has adopted. Cleanup is best effort and can be retried by the
orphan sweep; it does not need a pending-deletion table.

## Consequences

- A process stop after the database commit can leave an orphan, but cannot leave
  a current Avatar row pointing at a deleted object.
- Cleanup that fails or is cancelled may leave an object until the 24-hour
  orphan sweep runs.
- The previous decision in ADR-0068 that object deletion precedes the database
  change is superseded.
