# ADR-0175: Make Signed User Assertions single-use per Organization and environment

- Status: Accepted (per [#280](https://github.com/AiHub-Ecosystem/aihub-be/issues/280); the referenced ADR file was absent from this checkout)
- Related issue: [#280](https://github.com/AiHub-Ecosystem/aihub-be/issues/280)
- Amends: [ADR-0006](0006-redis-scoped-role-fail-open.md) Auth & authorization outage behavior
- Related: [ADR-0004](0004-signed-user-assertions-jwks.md), [ADR-0053](0053-optional-user-identity-verification.md), [ADR-0191](0191-organization-identity-issuer-control-and-release.md)

## Context

A valid Signed User Assertion identified its End-User but was not remembered
after verification. Anyone who captured it could submit it again before expiry,
including through another operation or another API key belonging to the same
Organization. Process-local replay state would also allow another application
instance to accept the same assertion.

## Decision

After verifying the signature and every existing claim, reserve a one-time
marker in shared Redis before controller work. Scope the marker to the
Organization, request environment, and assertion `jti`; the API key and
operation do not change that scope. Reserve atomically with `SET NX EX` and
retain the marker until `exp + 60 seconds`, covering the verifier's accepted
clock-skew window.

Preserve the existing audiences: Production accepts `aihub`, and Sandbox
accepts `aihub:sandbox`. A duplicate `jti` returns `401 INVALID_USER_IDENTITY`.
Keep the marker after later body validation, admission, or downstream failure.
If Redis errors, times out, or otherwise cannot confirm reservation, refuse
with retryable `503 IDENTITY_PROVIDER_UNAVAILABLE`; do not fall back to local
state. Declared User IDs and other credential types are unchanged.

Callers mint a fresh assertion with a fresh `jti` for every HTTP attempt,
including retries. For an operation that supports idempotency, reuse its
`Idempotency-Key` across retries while never reusing the assertion.

This is a narrow exception to ADR-0006's zero-Redis authorization boundary:
Redis holds only ephemeral replay-protection state, not durable identity data.

## Consequences

- A captured assertion can authorize at most one request across application
  instances, operations, and API keys for its Organization and environment.
- A Redis restart, restore, flush, or other loss of marker state can permit a
  still-valid assertion to be accepted again until the end of its validity
  window. The system does not guarantee replay prevention after Redis loses
  that state.
- An attacker holding both the assertion and a matching API key may win the
  first-use race. Single-use enforcement cannot identify which holder is
  legitimate.
- A caller must mint a new assertion after any failed HTTP attempt, even when
  the request did no downstream work. A retryable 503 does not prove whether a
  timed-out reservation reached Redis; fail closed and retry with a fresh
  assertion.
- No production deployment or production behavior is authorized or evidenced
  by this implementation record.

## Acceptance boundaries

- A valid assertion succeeds once; reuse returns `401 INVALID_USER_IDENTITY`
  without a second protected operation.
- Concurrent requests with the same Organization, environment, and `jti` admit
  at most one request.
- Reuse across API keys and operations is rejected; equal `jti` values in
  another Organization or environment remain independent.
- Invalid signatures, claims, issuers, audiences, and expired assertions are
  rejected before consuming replay state.
- A body or downstream failure after reservation does not release the marker.
- Redis refusal or uncertainty returns retryable `503
IDENTITY_PROVIDER_UNAVAILABLE` before protected controller work.
