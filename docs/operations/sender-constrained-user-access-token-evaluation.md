# Sender-constrained User Access JWT evaluation

Status: evaluation for [#1701](https://github.com/AiHub-Ecosystem/aihub-be/issues/1701). The decision of record is now [ADR-0176](../adr/0176-dpop-binds-web-session-jwts.md); this document keeps the analysis behind it.

## Scope

This evaluation answers whether AIHUB should sender-constrain User Access JWTs with DPoP ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)) or mTLS-bound tokens. It covers the user-facing Bearer boundary only. The grading boundaries (`X-API-Key`, `X-User-Identity`) are deliberately not bearer-JWT and are out of scope; changing them would need its own ADR.

The comparison case is the current credential: a 15-minute RS256 JWT whose holder can replay it from any client until expiry or individual revocation. Sender-constraining binds the token to a key the presenting client holds, so a copied token alone is not usable.

## Current boundary

- ADR-0022 defines the User Access JWT: RS256, a configured `kid`, 15-minute lifetime, and only `iss`, `aud`, `sub`, `jti`, `iat`, and `exp` claims. `JoseUserAccessTokenService.verify` requires the exact `kid`, algorithm, issuer, and audience; rejects non-integer or non-safe time claims; bounds total lifetime to 900 seconds; applies 60 seconds of clock skew; and validates the `usr_...` subject.
- ADR-0150 adds durable per-token revocation keyed by verified `(iss, jti)` in Postgres. Every protected Bearer request performs a direct revocation lookup; a local Bloom-filter miss never authorizes a token, and a database outage fails closed with retryable `503`. A user can revoke one leaked JWT immediately without ending sibling JWTs or sessions.
- ADR-0162 adds scope-bound audiences: Production and Sandbox no longer share a fixed `aihub-user-api` audience, so a token minted in one scope does not pass validation in the other.
- ADR-0081 gives the Customer Web an AIHUB-owned Web Session: the browser holds only an opaque HttpOnly cookie; the BFF exchanges that session server-to-server for a User Access JWT. There is no direct browser-to-AIHUB Bearer path in the shipped Customer Web.

Together these already narrow both the replay window and the blast radius: revocation is immediate, audience scoping prevents cross-scope replay, and the BFF keeps the long-lived credential server-side.

## DPoP mechanics and fit

RFC 9449 requires a separate DPoP JWT on each request, signed by the client's key. Its protected header carries the public key; its payload must bind the request method (`htm`), target URI without query or fragment (`htu`), an access-token hash (`ath`) when presented with a token, a unique `jti`, and an `iat`. The server verifies the signature, matches the token's `cnf.jkt` thumbprint to the proof key, checks the `htm`/`htu`/`ath` binding, applies time tolerance, and rejects replayed `jti` values. The RFC also defines a nonce mechanism for additional replay protection. mTLS-bound tokens move the same binding into the TLS client certificate layer instead, which changes the deployment and proxy contract entirely.

Applying either mechanism here requires decisions that do not yet exist:

- **Key placement.** For the Customer Web, a private key in the browser would survive a copied access token but would be exposed to browser-side script risk and require secure key generation, storage, and rotation in a frontend the AIHUB repository does not own. A BFF-held key moves proof-of-possession to the server-to-server hop and protects a different threat (a leaked session cookie used from another BFF), not a stolen browser token. Direct user-facing API clients do not ship today.
- **Proof-verification port.** Today `UserAccessTokenVerifierPort.verify(token)` takes one compact token. DPoP needs a second input (the proof JWT, the method, and the URI) and a port that can bind proof to token. ADR-0150's revocation service consumes only verified claims, so it can stay behind the same port if proof binding happens before it.
- **Replay cache.** DPoP `jti` replay protection is anti-replay protection state, not durable control-plane data: it can live in Redis with a bounded TTL tied to the proof window. Token revocation remains durable in Postgres under ADR-0150. These are distinct stores and must not be merged into one "security" table.
- **Hot path.** Every protected Bearer request would add one asymmetric signature verification, a public-key thumbprint comparison, method/URI/hash checks, a Redis `jti` check/write, and additional failure mapping. The current path already performs an RS256 JWT verification, an active-account lookup, and a Postgres revocation lookup. The extra work is predictable but not free on a shared two-vCPU host whose capacity thresholds are still being established (#581).
- **Migration.** Tokens are short-lived (15 minutes), so a dual-accept window is bounded, but the BFF and every direct client must send a proof header before verification can be required. The Customer Web lives in another repository. Rollout is a cross-repository contract change, not a local verifier edit.

## Cost of the status quo

The residual risk is narrow: within 15 minutes of a copied token leaving the BFF, an attacker can use it from another client until the owner revokes it. ADR-0150 gives the owner an immediate manual remedy; ADR-0162 prevents cross-scope use; ADR-0081 keeps the long-lived credential in an HttpOnly cookie. No incident class in the repository shows token replay as a realized attack, and no enterprise customer requirement is recorded.

## Decision

**Superseded on 2026-11-19: adopt for Web Session tokens.** The first version of this evaluation parked DPoP under three triggers. The owner then chose to build it for the Customer Web path, so [ADR-0176](../adr/0176-dpop-binds-web-session-jwts.md) is the decision of record. It covers key placement (browser, non-extractable), the proof-verification port, the Redis replay cache (ephemeral protection state, separate from ADR-0150's Postgres revocation), the `off`/`verify`/`enforce` rollout and the exclusion of the grading boundaries.

The analysis above still stands. What changed is the weighing: the work is accepted although none of the three original triggers has occurred. Those triggers described when to start; they are not conditions the build now waits for.

Open points the ADR leaves for the rollout, not for this evaluation:

- move the server to `verify` before the Customer Web starts sending DPoP; it should use the exchange response `token_type` and keep using Bearer until `verify` is active (separate repository);
- the owner chooses the `enforce` window and date after `sum(increase(aihub_user_access_token_use_total{scheme="bearer",session="web"}[1h]))` remains zero across app instances for that window; replace `1h` with the selected duration;
- `htu` behind nginx still needs a check with a real proxied request.

## Revisit

Revisit if a nonce (RFC 9449 §8) becomes necessary, if direct user-facing API clients ship, or if the same binding is wanted for login and refresh tokens. Extending it to the grading boundaries needs its own ADR.
