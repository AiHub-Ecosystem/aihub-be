# User accounts remain auth-owned; identity reads them directly with a recorded lock order

Identity continues to read `user_accounts` (and `auth_identities`) directly for status checks and display, rather than going through an auth-published read port. The ten existing cross-module reads are allowlisted with reasons in `scripts/checks/check-data-ownership.mjs`. Organization creation takes `FOR UPDATE` on the auth-owned `user_accounts` row before writing identity's `organizations`, so any future auth transaction that locks `user_accounts` and then touches an identity table must take the same order to avoid deadlock. Auth does not publish a narrow read surface for accounts at this time; that remains an option if the closure work (#649) changes account status/identifying columns.

- Status: Accepted
- Related issues: #692, #649
