# Cross-site BFF forwarding carries a CSRF contract for the refresh cookie

Amends: [ADR-0024](0024-rotating-refresh-session-boundary.md) — lifts its deferral of cross-site BFF/CSRF handling for the refresh-cookie routes.

ADR-0024 protects `POST /v1/auth/login`, `/v1/auth/refresh`, and `/v1/auth/logout` with the `__Host-aihub_refresh` cookie's `SameSite=Strict` and host-only binding. That defense lives in the browser and applies only to the hop the browser makes itself. When the Customer Web BFF forwards these calls from another site, the request AIHUB receives is server-to-server: SameSite never applies at that hop, and AIHUB must get its protection from the contract instead.

## Decision

The `X-AIHUB-Client-Secret` header marks the BFF-forwarded mode of the three refresh-cookie routes. The `OptionalWebSessionClientGuard` authenticates it exactly as on the Web Session routes; without the header the routes keep the ADR-0024 browser contract byte for byte, CSRF tokens included nowhere.

A forwarded call carries the rotating CSRF token in `X-AIHUB-CSRF-Token` and the end user's address in `X-AIHUB-End-User-IP`, which becomes the rate-limit key, because the BFF's shared peer address is never one (the ADR-0081 rule for its own routes). A forwarded login or refresh without the address answers `503 AUTH_WEB_SESSION_UNAVAILABLE` before any credential work.

- **Login** requires the pre-login CSRF token. A login has no session to bind one to yet, so the token is derived from the BFF client secret (an HMAC-SHA256 digest over a constant label): only code that already holds the secret can produce it, and it is not a credential.
- **Refresh and logout** require the session CSRF token: an HMAC-SHA256 digest over the presented refresh credential, keyed with the same secret. The token is therefore bound to the refresh session without a stored copy, and refresh rotation rotates it by construction — the new credential yields a new token, returned in the response body's `csrf_token` next to the access-token envelope. The BFF delivers the token to the browser, which presents it back on each forwarded call.
- A forwarded **refresh** without a valid token answers the generic `401 AUTH_REFRESH_TOKEN_INVALID` but preserves the cookie: clearing it would let a CSRF probe that cannot produce the token still log the victim's browser out. A forwarded **logout** without one keeps the quiet bodyless `204` and revokes nothing, so a probe learns nothing either way. Real invalid-credential answers keep ADR-0024's cookie-clearing behavior in both modes.
- AIHUB still sets the same cookie attributes in both modes; the browser-facing SameSite defense keeps protecting the browser↔BFF hop, and this contract covers the hop SameSite cannot see.

Trust boundary: the contract assumes the BFF faithfully relays what the browser presents. A compromised or dishonest BFF holds the client secret and the relayed cookie and defeats any client-side scheme; that failure is out of scope here.

## Consequences

- `auth.verify_email` (the Verification Sign-in of ADR-0054) and the register route stay same-site-only; giving them the contract is follow-up work, and a forwarded `verify_email` today cannot carry the BFF guard.
- Rotating the BFF client secret invalidates every outstanding CSRF token at once; sessions survive but their holders must sign in again. Secret rotation is an operator event, so this is accepted. If binding must outlive a secret rotation, the upgrade is a stored random token hashed beside the refresh session.
- The `csrf_token` response field and the header are additive on the `/v1` contract (1.9.0); `/v2` carries no refresh-cookie routes.

- Status: Accepted (amends ADR-0024)
- Related issue: [#1720](https://github.com/AiHub-Ecosystem/aihub-be/issues/1720)
- Related: [ADR-0024](0024-rotating-refresh-session-boundary.md), [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md), [#821](https://github.com/AiHub-Ecosystem/aihub-be/issues/821)
