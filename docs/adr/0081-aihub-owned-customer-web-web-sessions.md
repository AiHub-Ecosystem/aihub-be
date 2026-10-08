# ADR-0081: AIHUB owns the Customer Web Web Session

- Status: Accepted
- Date: 2026-10-08
- Amends: [ADR-0046](0046-customer-web-aihub-auth-identity-boundary.md) — its "Session and authorization boundary" section
- Related: [#347](https://github.com/AiHub-Ecosystem/aihub-be/issues/347), [#345](https://github.com/AiHub-Ecosystem/aihub-be/issues/345), [ADR-0024](0024-rotating-refresh-session-boundary.md), [ADR-0025](0025-password-recovery-boundary.md), [ADR-0054](0054-verification-sign-in-bound-to-signup-browser.md)

The Customer Web login session becomes a first-class AIHUB concept, the **Web Session**, stored in AIHUB's own Postgres. This amends ADR-0046, which put that session in a dedicated Redis owned by the BFF. It does not rewrite ADR-0046: the browser-holds-only-an-opaque-cookie rule, the 30-day TTL, the fail-closed cutover, and the membership decision cache all survive unchanged.

## Recorded conflict

#345 said "ADR-0046 documents". This repo amends an accepted ADR instead of rewriting it, so the decision lives here and ADR-0046 carries an annotation pointing forward. Its original text stays readable as the decision that was superseded.

## What a Web Session is

A Web Session is not a Refresh Session. It has no Refresh Token Family, its token does not rotate, and it lives in its own table rather than `refresh_tokens`.

- Its credential is an opaque 32-byte CSPRNG value. AIHUB stores only its SHA-256 hash, so a database leak reveals no usable session.
- Lifetime is 30 days sliding with no absolute cap. A successful exchange renews the expiry, and the renewal writes at most once an hour. Renewal only ever moves the expiry forward, and never applies to a revoked or expired session — which is why concurrent BFF requests need no lock.
- One verification token creates at most one session in total, whether a Web Session or a Refresh Session. Both kinds pass through the same one-time claim, so that guarantee is a property of the claim rather than of two code paths agreeing.
- Logout revokes only the presented session, idempotently. There is no log-out-all-devices route, no session listing, and no per-user cap.
- A password reset ends every Web Session of the account inside the transaction that already ends every Refresh Token Family.
- A disabled account cannot exchange its session and its sessions stay in place, so disabling takes effect quickly without destroying audit state.

## The server-to-server boundary

The four Web Session routes are for the Customer Web BFF only, authenticated by one static client secret in a dedicated header, compared in constant time and checked before any credential or session lookup. The Web Session token travels in the request body only; offered in a cookie, an `Authorization` header, or a query parameter it is refused. A stolen Web Session token alone is therefore not usable against AIHUB.

The BFF exchanges a session for a short-lived User Access JWT on demand, which it may cache in process until shortly before it expires. AIHUB stores no JWT and keeps no revocation list, so a JWT signed before a logout can stay valid for up to 15 minutes — the same window the Bearer boundary already has. An invalid, expired, revoked, unknown or malformed session answers one generic `401`; an infrastructure failure answers `503` with no credential, so the BFF can keep its cookie and tell a temporary fault from a bad session.

## Consequences

- The BFF stops needing a dedicated session Redis. AiHub-Frontend#50 removes it after this ships.
- A session state outage is a control-plane database concern, so backup, inspection and incident response use the store AIHUB already runs.
- Expired and revoked rows are not purged yet. This is a deliberate ceiling: add a scheduled purge when the table grows enough to matter.
- Existing Bearer-token and API-key clients see no change. The Web Session routes are additive and may deploy before the frontend cutover.
- Release depends on Vault: the secret's Vault template must be staged and `vault-agent` restarted before the merge to `main`, because CD deploys `main` and never restarts the agent. A production or staging image without the secret refuses to boot.
- Existing frontend Redis sessions are not migrated. At cutover users sign in again once and the flow fails closed, following ADR-0046's "Session state is never migrated".

## Google login handoff

The future Google sign-in from #93 creates a **Web Session**, not a refresh credential. The exchanged authorization code yields a Web Session the BFF holds the same way a password login does; no Refresh Token Family is created for it. This ADR records the decision only — #93 owns the implementation.
