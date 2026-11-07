# ADR-0004: Signed User Assertions verified against per-organization JWKS

- Status: Accepted (retroactive record; made optional per organization by ADR-0053)
- Date: decided 2026-09-07 in the implementation specification suite; file written 2026-11-07

## Context

Grading requests carry an end-user identity. AIHUB must know whose essay is
being graded — for abuse attribution and billing — without becoming an identity
provider for every customer. Customers have strong dev teams and can sign
assertions.

## Decision

End-user identity arrives as a Signed User Assertion (a JWT) in
`X-User-Identity`, signed by the customer's IdP and verified by AIHUB against
that organization's own identity configuration: issuer, JWKS URL or inline
public JWKS, algorithm allowlist, and maximum assertion TTL.

- `issuer` is globally UNIQUE in the identity configuration store. Without that
  constraint, organization B could register organization A's issuer and sign
  assertions impersonating A's users — one unique index eliminates an entire
  class of cross-tenant attacks.
- Strict TTL caps and an algorithm allowlist (RS256/ES256) bound replay and
  algorithm-confusion risk.
- Only an active `owner` of an active organization may read or replace the
  identity configuration (ADR-0055).
- Since ADR-0053 (2026-09-26), verification is optional per organization:
  without an active configuration the header carries a Declared User ID
  accepted unsigned; with one active, a plain value is rejected rather than
  downgraded, and a configuration or JWKS failure stays
  `503 IDENTITY_PROVIDER_UNAVAILABLE` and never falls back to the declared form.

## Consequences

- AIHUB never stores end-user credentials; it stores only verification policy.
- Per-organization JWKS means a compromise is scoped to one tenant's
  assertions.
- The sandbox demo mints its own assertions under a dedicated audience
  (`sandbox-assertion` path in the runtime secret set).
