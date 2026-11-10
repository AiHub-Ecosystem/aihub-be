# ADR-0160: Password change preserves the current session

- Status: Accepted
- Date: 2026-11-10
- Related: [#388](https://github.com/AiHub-Ecosystem/aihub-be/issues/388), [ADR-0128](0128-persisted-values-and-vault-document-keys-are-read-before-they-are-written.md)

## Context

Issue #388 adds an authenticated password change. The route is on the Bearer boundary, requires the current password, and on success revokes every other Refresh Session and Web Session while keeping the session that made the request. There is no separate log-out-all-devices route; password change is the account's self-service path to revoke other sessions.

The current User Access JWT identifies only the User Account and token instance. It does not identify the Refresh Session or Web Session that issued it, so the password-change transaction cannot preserve the current session while revoking the others.

## Decision

A User Access JWT may carry a `session` claim whose value is `{ kind: 'refresh' | 'web', id: string }`. The `id` is the stable Refresh Token Family ID or Web Session ID. The verifier accepts legacy tokens without the claim and validates the value when it is present; the Bearer request principal carries the parsed session identity.

The claim follows ADR-0128's reader-first order. The first release teaches the verifier and request principal to read the optional claim and does not issue it. A later release may issue the claim and ship password change only after the reader release is deployed. No route or email notification is added in the reader-only release.

## Consequences

Older releases ignore the new claim as an unknown JWT claim. The reader release continues accepting existing tokens without it. The later writer release can identify exactly one current session for the atomic password update and revoke all other sessions. A rollback to the reader release remains compatible with tokens carrying the optional claim.

The password-change operation and its notification remain unshipped until the writer release. This decision does not add session listing or a separate log-out-all-devices operation.
