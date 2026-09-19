# ADR-0022: AIHUB-owned local user authentication alongside the sandbox identity boundary

- Status: Accepted

## Amendment for issue #64 (2026-09-19)

The first delivered slice is registration, email verification, and generic
verification resend only. It persists `user_accounts`, `auth_identities`, and
hash-only `email_verification_tokens` in Postgres. Passwords use Argon2id
(`m=65536,t=3,p=1`, 16-byte salt, 32-byte hash) and verification tokens use
opaque random values with SHA-256 hashes and a 24-hour expiry. Verification is
an atomic consume-plus-activation transition; resend consumes prior open
tokens before inserting one replacement. Resend delivery uses the typed
runtime-secret provider and the Resend adapter. Login, JWT, refresh, recovery,
and federation remain future slices and are not implied by this amendment.

AIHUB will own a local user-authentication plane for email/username/password registration, email verification, login, password recovery, and User Access JWT plus rotating Refresh Token issuance. Registration creates only an AIHUB User Account; Organization Membership and API-key provisioning remain separate, and access tokens do not pin a user to one organization. The existing Customer Web sandbox continues to use Clerk under ADR-0020 while this plane is introduced, and User Access JWTs do not replace the `X-API-Key` and User Assertion boundaries on grading routes. This keeps the new credential flow independently testable without breaking the running sandbox; a later migration may supersede the sandbox identity decision explicitly.

The access token is an RS256 JWT with a `kid`, a 15-minute lifetime, and only issuer, audience, subject, token id, issued-at, and expiry claims. The refresh credential is opaque, stored only as a hash, delivered through a secure HttpOnly SameSite cookie, expires after 30 days, rotates on use, and revokes its token family on reuse. Registration returns a pending-verification account without tokens; verification and password reset use expiring opaque tokens, while login, refresh, logout, and recovery follow the agreed auth API contract.

The contract normalizes and uniquely constrains email and username, uses account states `pending_verification`, `active`, and `disabled`, and keeps membership state separate. Resend is the production email provider for verification and password-recovery messages, reached through the application-owned email port; its API key and sender configuration are runtime secrets/configuration. Auth failures use stable auth-specific error codes without exposing credential or account-existence details; login, registration, refresh, and recovery are rate-limited without permanent account lockout. Auth success responses use the shared `{ data, meta: { request_id } }` envelope, with no body for the agreed `204` operations.
