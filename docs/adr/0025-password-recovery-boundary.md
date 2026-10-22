# ADR-0025: Generic password-recovery boundary

- Status: Accepted; email-delivery decision amended by [ADR-0074](0074-transactional-email-outbox.md); reset-link behavior amended by [ADR-0046](0046-customer-web-aihub-auth-identity-boundary.md); session ordering against a reset amended in this record by #843
- Related issue: #67

Password Recovery applies only to active local password Auth Identities. A
valid, rate-allowed request always uses the same generic `202` response for
known and unknown addresses; pending-verification and disabled accounts do not
receive a reset credential, and Resend delivery failures remain generic while
durable-storage failures retain a safe `5xx` result. Password Reset Tokens are
separate from Email Verification tokens, opaque, hash-only, one-hour,
single-use credentials with one open token per account; a newer request
invalidates the previous one. At the time of this decision, no reset URL,
outbox, or provider-specific error was part of this boundary. ADR-0074 later
amends the outbox and asynchronous delivery decision. ADR-0046 amends the
no-reset-URL boundary: when `CUSTOMER_WEB_BASE_URL` is configured, password
reset emails include the Customer Web deep link; when it is unset, email
delivery remains token-only. The generic response and token lifecycle remain
in force.

Reset consumption rechecks that the account is active and atomically consumes
the token, replaces the Argon2id password hash, invalidates other open reset
tokens, and revokes every Refresh Token Family. Concurrent attempts have one
winner. Success returns bodyless `204` with `Cache-Control: no-store` and
clears the current refresh cookie; existing User Access JWTs expire naturally
within their existing short lifetime. Consumed and expired reset rows remain
until a later bounded cleanup concern.

## Ordering against a session (amended by #843 and #897)

Revoking every Refresh Token Family is only as strong as its ordering against a
session that was being created or rotated while the reset ran. Two rules make
that ordering hold:

- **A new session proves its password is still current.** A sign-in that creates
  a Refresh Session passes the password hash it verified, and the insert
  compares it with the stored hash in its own transaction, after the lock it
  takes on the User Account row. A reset that committed between the check and
  the insert is therefore seen, and the sign-in is refused as an invalid
  credential with no session row left behind. The Customer Web session, and
  a second-factor removal proved by password, already carried this comparison.
- **The User Account row is locked before any token row.** Reset consumption
  and Refresh Token rotation lock the account first, then read their token under
  that lock. Each outcome is unchanged: a used, revoked, or expired token and an
  inactive account answer as before. A rotation that reaches the account while a
  reset holds it waits and then finds its token revoked, instead of holding the
  token the reset needs to revoke. Two resets that consume one token have one
  winner, and the other answers the ordinary invalid-token result with the
  password unchanged, because the token is spent before the password is written;
  it is no longer a server error.

Reset-link issue, second-factor removal, verification consumption, and logout keep
the orders they have today. Aligning them is #853, which also records the order
as an amendment to ADR-0107, where Identity takes the same account-first order.
