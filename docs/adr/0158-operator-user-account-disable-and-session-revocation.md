# ADR-0158: Operator disable of User Accounts and session revocation boundary

- Status: Accepted
- Date: 2026-11-08
- Related: [#367](https://github.com/AiHub-Ecosystem/aihub-be/issues/367), [#302](https://github.com/AiHub-Ecosystem/aihub-be/issues/302), [#488](https://github.com/AiHub-Ecosystem/aihub-be/issues/488), [#518](https://github.com/AiHub-Ecosystem/aihub-be/issues/518), [#293](https://github.com/AiHub-Ecosystem/aihub-be/issues/293), [ADR-0022](0022-aihub-local-user-authentication.md), [ADR-0024](0024-rotating-refresh-session-boundary.md), [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md), [ADR-0150](0150-revoke-individual-user-access-jwts.md)

## Context

Prior to this decision, responding to an abusive or compromised AIHUB User Account required hand-written SQL directly against the production database during an incident. Although the domain defined a `disabled` account status that `UserAccessJwtGuard` and local login checked, no operator command or code path ever set it. Furthermore, revoking all of an account's sessions at once was impossible without a password reset initiated by the user. Rotating the User Access JWT key invalidates access tokens at startup, but unrevoked refresh tokens continued to mint new access tokens indefinitely.

## Decision

1. **Operator Commands (`pnpm cli`)**:
   - `user:disable --user <id-or-username> --actor <operator>`: Sets the target User Account status to `disabled` and revokes every active Refresh Session (`refresh_tokens`), active Web Session (`web_sessions`), open Email Verification Token (`email_verification_tokens`), and open Password Reset Token (`password_reset_tokens`) belonging to the account in a single atomic transaction. Requires `--actor` identifying an active AIHUB User Account.
   - `user:restore --user <id-or-username> --actor <operator>`: Restores a disabled User Account to `active`. It intentionally does not restore or un-revoke any previously revoked session or token.
   - `session:revoke-all-refresh --actor <operator>`: Revokes every active Refresh Session across all accounts by marking `revoked_at = now()`. Designed for emergency containment alongside User Access JWT key rotation ([#293](https://github.com/AiHub-Ecosystem/aihub-be/issues/293), [#365](https://github.com/AiHub-Ecosystem/aihub-be/issues/365)).

2. **Residual User Access JWT Window**:
   - User Access JWTs are stateless and contain `sub` and `jti` but no session identifier (tracked in [#488](https://github.com/AiHub-Ecosystem/aihub-be/issues/488)).
   - While an account remains `disabled`, `UserAccessJwtGuard` checks the account's durable status on every Bearer request and rejects any non-active account with `AUTH_USER_ACCESS_TOKEN_INVALID`.
   - If an operator restores the account to `active` before a pre-disable JWT reaches its original expiry, that JWT can become usable again for the remainder of its lifetime (bounded by `expiresInSeconds`, at most 15 minutes, plus 60 seconds clock skew).
   - We explicitly accept this residual window bounded by original expiry until [#488](https://github.com/AiHub-Ecosystem/aihub-be/issues/488) introduces session IDs into User Access JWTs. If a specific JWT is known to be compromised, operators or users may revoke that individual JWT immediately via [#518](https://github.com/AiHub-Ecosystem/aihub-be/issues/518) ([ADR-0150](0150-revoke-individual-user-access-jwts.md)).

3. **Durable Audit Trail**:
   - Both disable and restore acts, as well as global refresh session revocation, record a durable audit entry in `user_account_status_audits`.
   - The table records `id` (`uasa_<ulid>`), `user_account_id` (nullable for global revocation), `actor_user_account_id`, `actor_source` (`self_declared_operator`), `action` (`user_account.disabled`, `user_account.restored`, `refresh_session.revoked_all`), `request_id`, and `occurred_at`.
   - The table is protected by an append-only database trigger. No credentials, tokens, or hashes are recorded.

## Consequences

- An operator can contain a compromised account or perform an emergency key rotation from the CLI without manual SQL.
- All sessions and open tokens are invalidated atomically upon disable.
- Restoring an account restores access permissions without reviving revoked sessions.
- Pre-disable User Access JWTs carry an accepted residual window of at most 15 minutes upon reactivation, documented and tested.
