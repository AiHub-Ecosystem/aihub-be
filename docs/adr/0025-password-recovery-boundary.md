# ADR-0025: Generic password-recovery boundary

- Status: Accepted; email-delivery decision amended by [ADR-0074](0074-transactional-email-outbox.md)
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
amends only the outbox and asynchronous delivery decision; the generic
response, token lifecycle, and no-reset-URL boundary remain in force.

Reset consumption rechecks that the account is active and atomically consumes
the token, replaces the Argon2id password hash, invalidates other open reset
tokens, and revokes every Refresh Token Family. Concurrent attempts have one
winner. Success returns bodyless `204` with `Cache-Control: no-store` and
clears the current refresh cookie; existing User Access JWTs expire naturally
within their existing short lifetime. Consumed and expired reset rows remain
until a later bounded cleanup concern.
