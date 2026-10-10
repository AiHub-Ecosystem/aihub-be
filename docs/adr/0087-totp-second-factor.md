# ADR-0087: Add an optional TOTP second factor to local login

- Status: Accepted
- Date: 2026-10-10
- Related: [#467](https://github.com/AiHub-Ecosystem/aihub-be/issues/467), [#461](https://github.com/AiHub-Ecosystem/aihub-be/issues/461), [#484](https://github.com/AiHub-Ecosystem/aihub-be/issues/484), [ADR-0074](0074-transactional-email-delivery-outbox.md), [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md)

## Decision

Local password login and Customer Web BFF Web Session creation support an
optional TOTP second factor. A correct password without a required code answers
`202 MFA_REQUIRED` and creates no session. The second request resubmits the
email, password, and TOTP or Recovery Code. No durable login challenge is
created; the Customer Web holds the password only in transient form memory and
clears it after completion or reset.

TOTP uses HMAC-SHA1, six digits, and 30-second steps with one adjacent step of
clock tolerance. Each account receives eight cryptographically random Recovery
Codes at confirmation. Recovery values are stored as SHA-256 hashes and are
consumed in the same database transaction that creates a Refresh Session or
Web Session, so a concurrent replay can create at most one session.

Enrollment requires a fresh password and returns the generated secret once.
Confirmation requires a valid TOTP and returns the Recovery Codes once. Factor
removal requires a fresh password or TOTP, deletes the factor and hashes,
revokes all durable Refresh Sessions and Web Sessions, and queues an email
notice in the same transaction. Already-issued stateless User Access JWTs can
remain valid for at most 15 minutes, matching the existing session boundary.

Encrypt TOTP secrets with AES-256-GCM using a random 96-bit nonce and
user/factor-bound authenticated data. Load a dedicated keyring from the
`auth-mfa` Vault bundle and a standalone rendered file. Keep prior key IDs
available while factors still reference them. Never log or persist plaintext
TOTP secrets or Recovery Codes.

Wrong password, TOTP, or Recovery Code produces the existing generic
`AUTH_CREDENTIALS_INVALID` response and consumes existing login limits. A
factor-change email includes only the email address and action. The new
outbox kinds are written only after the #489 unknown-kind reader is deployed;
N-1 skips unknown kinds and continues dispatching neighboring rows.

## Follow-up

There is no Organization-level MFA policy in this release. Track a separate
owner/admin enforcement decision before requiring factors for privileged
Organization routes. If adopted, it should block privileged owner/admin actions
for unenrolled accounts while leaving ordinary members' account access intact
and providing an account-level recovery path. The current feature leaves all
Organization routes and roles unchanged.
