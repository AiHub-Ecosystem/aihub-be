# Sender-constrained User Access JWT evaluation

Status: evaluation for [#1701](https://github.com/AiHub-Ecosystem/aihub-be/issues/1701). This is a decision record, not an ADR and not an authorization to change the Bearer boundary.

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

**Park under named triggers. Do not adopt DPoP or mTLS binding now.**

Revocation plus audience scoping is sufficient at the current risk level. Adding a proof key would move the security boundary into a frontend repository and add hot-path verification and replay state for a threat that has not been observed. This is a deferral with conditions, not a rejection: DPoP is the right mechanism if the trigger arrives.

Named triggers, any one of which reopens this issue:

1. **A real token-theft incident class** with evidence that copied User Access JWTs were replayed from another client within the 15-minute window and that revocation was too slow to contain it.
2. **An enterprise security requirement** in a signed customer contract that explicitly requires sender-constrained tokens or equivalent proof-of-possession.
3. **Direct user-facing API access ships**, so a client holds the token in a non-BFF environment where the current HttpOnly-cookie protection no longer applies.

If adopted later, the implementation issue must name:

- a proof-verification port behind the Bearer boundary, separate from `UserAccessTokenVerifierPort.verify` but composed before authorization;
- Redis (bounded TTL, keyed by proof `jti` and scope) as ephemeral anti-replay protection state, with Postgres revocation under ADR-0150 unchanged;
- the client key contract per client type, including rotation, and a cross-repository rollout with the Customer Web; and
- an explicit decision that the grading boundaries remain excluded.

Those are requirements for the follow-up, not decisions taken unilaterally here.

## Revisit

Review this evaluation when a trigger above occurs, or when the owner records a formal acceptance of the residual 15-minute replay window as part of a launch or enterprise review. No code, dependency, or runtime configuration changes ship under this issue.
