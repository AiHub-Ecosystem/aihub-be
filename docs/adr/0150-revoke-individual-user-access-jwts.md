# ADR-0150: Durably revoke individual User Access JWTs

- Status: Accepted
- Date: 2026-11-05
- Amends: [ADR-0022](0022-aihub-local-user-authentication.md) — the clause that authorization checks account status rather than a `jti` revocation list; [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md) — the statement that AIHUB keeps no User Access JWT revocation list. Logout's existing session behavior and its post-logout token tail remain unchanged.
- Related: [#518](https://github.com/AiHub-Ecosystem/aihub-be/issues/518), [#488](https://github.com/AiHub-Ecosystem/aihub-be/issues/488), [ADR-0118](0118-postgres-outage-answers-retryable-503.md)

## Context

User Access JWTs are stateless and can remain valid until expiry after their bearer leaks. Session-wide revocation is handled separately by #488, but it does not revoke only one JWT while leaving sibling JWTs usable. Issue #518 adds that narrower recovery action and reverses the prior decision to keep no JWT revocation list.

## Decision

- An active AIHUB User Account may use an authenticated Auth `POST` operation to revoke one User Access JWT. The request carries the target JWT in its body; the verifier validates it and the application receives only verified claims. The caller and target must have the same verified `sub`. The target may also be the caller's current Bearer JWT.
- Persist revocation state in Postgres, keyed by the verified `(iss, jti)` pair. Retain the record through `exp` plus the verifier's 60-second clock skew. Never persist or log the raw JWT. Redis is not the source of truth.
- The Bearer boundary checks the durable revocation state on every protected request. A committed revocation rejects the target on its next request. Do not cache a negative revocation lookup. A store error fails closed; a Postgres outage answers retryable `503 DATABASE_UNAVAILABLE` under ADR-0118.
- Invalid targets, targets whose `sub` differs from the caller, and targets beyond the accepted expiry skew receive the same generic invalid-token `401`; no revocation record is written.
- A successful revoke returns bodyless `204`, including when the same target was already revoked and the caller remains authorized. If the caller's Bearer JWT is also the target, the first request succeeds and later requests with that JWT are rejected by the normal Bearer boundary; there is no exception for revoked callers.
- At `exp` plus clock skew, the record stops affecting authorization and becomes eligible for bounded cleanup. This issue adds no cleanup scheduler. Expiry coverage verifies this boundary and eligibility, not a periodic purge.
- Revoking one JWT does not revoke a sibling JWT or end a Refresh Session or Web Session. Session-wide revocation remains separate under #488.

## Consequences

Bearer requests now depend on a durable Postgres revocation read as well as the active-account check; database outages refuse access with a retryable response. A user can invalidate one leaked JWT immediately without disrupting sibling JWTs or login sessions. Expired revocation rows may remain until a bounded cleanup is introduced.
