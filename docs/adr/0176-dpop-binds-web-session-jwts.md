# ADR-0176: DPoP sender-constrains Web Session User Access JWTs

- Status: Accepted
- Date: 2026-11-19
- Amends: [ADR-0022](0022-aihub-local-user-authentication.md) — the Bearer boundary no longer suffices for a Web Session token once enforcement is on
- Related: [#1701](https://github.com/AiHub-Ecosystem/aihub-be/issues/1701), [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md), [ADR-0150](0150-revoke-individual-user-access-jwts.md), [ADR-0162](0162-scope-bound-user-access-jwt-audiences.md), [evaluation](../operations/sender-constrained-user-access-token-evaluation.md)

## Context

A User Access JWT is a pure bearer credential: whoever copies it can replay it from any client for up to 15 minutes, or until it is individually revoked (ADR-0150). The evaluation for #1701 parked DPoP (RFC 9449) under three named triggers. The owner then decided to build it, so this record replaces that "park" decision for the Customer Web path. The evaluation document stays as the analysis; its decision section points here.

## Decision

- **Scope.** Only User Access JWTs minted by Web Session exchange (`session.kind = web`) can be bound to a key and, under enforcement, must be. Login, refresh and registration tokens stay Bearer. The `X-API-Key` and `X-User-Identity` grading boundaries are untouched; changing them needs their own ADR.
- **Threat.** A User Access JWT stolen from the browser. The Client proof key lives in the browser as a non-extractable key. A key held by the BFF would protect a different hop and is not this decision.
- **Binding.** `POST /v1/auth/web-sessions/exchange` accepts an optional `client_proof_key`, a public JWK (`kty: EC`, `crv: P-256`, `x`, `y`; the schema is closed, so `d` or any other member is refused with `400 INVALID_REQUEST`). When present, the issued JWT carries `cnf.jkt`, the RFC 7638 thumbprint. Without it the token is unbound, as before. This is an additive `/v1` change (contract 1.18.0).
- **Proof.** The client presents `Authorization: DPoP <jwt>` and a `DPoP: <proof>` header. The verifier accepts `typ: dpop+jwt`, `alg: ES256` and an embedded P-256 public key only, and checks that the key's thumbprint equals the token's `cnf.jkt`, `htm` equals the method, `htu` equals the request URL without query or fragment, `ath` is the SHA-256 of the exact access token, `iat` is within the 60-second clock skew, and `jti` was not seen. No other algorithm or curve is accepted.
- **`htu`.** Built from the trusted-proxy scheme and hostname plus the request path. A client-chosen `Host` is not trusted without the trusted-proxy configuration.
- **No server nonce** (RFC 9449 §8) in the first release. The `jti` check inside the proof window covers replay. A nonce stays a later upgrade.
- **Replay state.** Redis, key `(issuer, jkt, proof jti)` hashed, `SET NX` with a TTL of `2 × skew + 60` = 180 seconds. This is ephemeral protection state, separate from the durable Postgres revocation of ADR-0150, which is unchanged. If Redis cannot answer, the guard fails closed with retryable `503 REDIS_UNAVAILABLE`. It never trusts an unchecked proof and never falls back to Bearer.
- **Errors.** A bad proof reuses `AUTH_USER_ACCESS_TOKEN_INVALID` (`401`) with `WWW-Authenticate: DPoP algs="ES256"`. No new public error code is added, because a new code would also need a CHANGELOG entry and a release-gate acceptance for every major.
- **Mode.** `AIHUB_DPOP_MODE` is `off` (default; Bearer only), `verify` (DPoP also accepted, Bearer still works) or `enforce` (a Web Session token must come with a valid proof; Bearer for it answers `401`). Only routes behind `UserAccessJwtGuard` are affected.
- **Lost key.** If a browser loses its key, the client signs in again. There is no re-registration of a key by presenting the Web Session, and the BFF keeps no spare key.
- **Measuring the cutoff.** `aihub_user_access_token_use_total{scheme,session}` counts each presentation of a verified token in every mode, including Bearer use that `enforce` then refuses. `scheme="bearer",session="web"` is the Bearer traffic still left.

## Rollout

1. Deploy at `off`. Nothing changes.
2. The Customer Web releases a version that creates the key, sends `client_proof_key` at exchange, and sends `DPoP` on every call.
3. Move to `verify`. Watch `aihub_user_access_token_use_total{scheme="bearer",session="web"}`.
4. Move to `enforce` only after that series has stayed at zero for a window the owner picks. The owner sets the date in the rollout issue; this record does not invent one.

## Consequences

- `enforce` locks out any Web Session whose token was minted without `client_proof_key`, because an unbound token cannot present a proof. The frontend must send the key before `enforce`. A token minted before the switch fails the same way until the next exchange, at most 15 minutes.
- Every DPoP request adds one ES256 verification and one Redis write. The Redis write is on the request path and counts against Redis availability for these routes.
- The Customer Web (separate repository) owns key generation, storage and proof signing. The server cannot enforce what that client does until it ships.
- Rolling back to an image that predates this ADR still verifies a bound token, because the verifier ignores unknown claims such as `cnf`, and so it accepts that token as plain Bearer. It refuses requests that use the `DPoP` scheme until a newer image is redeployed. Rolling back during `enforce` therefore weakens the binding for that period and breaks clients that only send `DPoP`.
