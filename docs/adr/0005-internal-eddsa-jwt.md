# ADR-0005: Internal EdDSA JWT for AIHUB-to-AI-service authentication

- Status: Accepted (retroactive record)
- Date: decided 2026-09-07 in the implementation specification suite; file written 2026-11-07

## Context

AIHUB forwards requests to private AI services over a private network. The
services must know (a) the request genuinely passed AIHUB's admission and
(b) on whose behalf, without accepting client-supplied identity fields.

## Decision

AIHUB signs a short-lived internal JWT per downstream request:

- **EdDSA (Ed25519)** over RS256: ~50 µs signing vs ~1 ms, much smaller tokens;
  both ends of the wire are under AIHUB's control, so there is no compatibility
  barrier. The header carries `kid` + `alg` for graceful fallback if a
  third-party service ever needs RS256.
- **Per-service `aud` targeting:** a token minted for `ai-writing` is rejected
  by `ai-speaking`. Compromise of one AI service does not grant the ability to
  call another.
- **TTL 60 s**, minted just-in-time, never stored in the database, no refresh
  mechanism.
- **`jti` = request_id** at zero cost, unifying distributed tracing between
  AIHUB and the AI service.
- Key rotation is a five-step zero-downtime procedure (publish new public key,
  keep signing with the old, wait past cache TTL, switch signing, retire the
  old key), run every 3 months or on suspected compromise; the runbook is
  specified in [05-auth-identity §G.8](../superpowers/specs/2026-09-07-aihub/05-auth-identity.md).
- Identity travels in the signed token, never in a request body (threat 12).

## Consequences

- mTLS is deferred: private networking plus signed internal JWTs suffice for
  Stage A; multi-tenant shared infrastructure or compliance audits are the
  trigger to revisit (threat 16, "Later").
- Current implementation ships Phase 1 (`ConfiguredTokenIssuer`, a static
  internal token) behind the `InternalTokenIssuerPort`; minting per-request
  JWTs is the planned Phase 2 replacement that does not change the dispatcher
  port.
- Internal tokens are secrets: they are redacted before logging
  (security rules) and delivered through Vault (ADR-0013).
