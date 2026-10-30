# User accounts remain auth-owned; identity reads them directly with a recorded lock order

Identity continues to read `user_accounts` (and `auth_identities`) directly for status checks and display, rather than going through an auth-published read port. The ten existing cross-module reads are allowlisted with reasons in `scripts/checks/check-data-ownership.mjs`. Organization creation takes `FOR UPDATE` on the auth-owned `user_accounts` row before writing identity's `organizations`, so any future auth transaction that locks `user_accounts` and then touches an identity table must take the same order to avoid deadlock. Auth does not publish a narrow read surface for accounts at this time; that remains an option if the closure work (#649) changes account status/identifying columns.

- Status: Accepted
- Related issues: #692, #649, #853

## Auth credential and session lock order (amended by #853)

An Auth transaction that locks more than one credential or session row takes the User Account row first. It may then lock the password identity, MFA factor and recovery codes, and the relevant verification, password-reset, Refresh Token, or Web Session rows. A token owner lookup may precede the account lock only when it is an unlocked read of an immutable `user_account_id`; the transaction must re-read and lock the token after acquiring the account. Family-wide revocation follows that order, so logout, rotation, password reset, and MFA removal serialize through the same account row. Keep inline comments at these transaction entry points naming this order.
