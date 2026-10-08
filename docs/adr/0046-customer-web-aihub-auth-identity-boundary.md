# ADR-0046: Customer Web identity boundary on AIHUB auth and Organization Membership

- Status: Accepted
- Related issue: #94
- Supersedes: ADR-0020 — Amends: ADR-0021 — Updates notes: ADR-0022, ADR-0027
- Amended by: [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md) — the "Session and authorization boundary" section below is superseded

AIHUB becomes the source of truth for User Accounts, Auth Identities, invitations, membership status and roles, and user-facing session authorization of the Customer Web sandbox. Clerk is not a fallback provider. This supersedes ADR-0020's Managed-IdP decision and amends only the identity clauses of ADR-0021, whose non-identity grading invariants remain in force unchanged. The UI and BFF keep one origin, the browser stays free of provider and API credentials, and the existing sandbox Organization mapping, server-held Sandbox API key, per-request assertion, no-store grading behavior, and safe error boundary all survive the move.

## Cutover and rollback

Preparation is phased but the flip is singular: email/password and BFF work may be built early, yet cutover happens only once both login paths — local credentials and the Google OIDC path from #93 — are available. No dual-auth window exists; at the flip every Clerk session is invalidated and users re-login fail-closed against AIHUB auth. Session state is never migrated.

Rollback is a redeploy of the previous image tag, not a dual-auth flag, so the post-flip image contains no Clerk SDK, API call, secret, cookie, webhook, or environment reference — the deployed path is the code path, verified against the build artifact. Deployment configuration may retain unread Clerk environment variables for the 14-day rollback window; they are removed at the +30-day mark when Clerk data becomes read-only behind a cold-storage export, and the Clerk directory is deleted at +90 days. Rollback never deletes AIHUB accounts or memberships created during a flipped window: newer data is preserved, and re-flipping is safe because migration is idempotent.

## Session and authorization boundary

The browser holds only an opaque session cookie (HttpOnly, Secure, SameSite=Strict). The AIHUB User Access JWT and refresh credential live server-side in a dedicated Redis instance that is not shared with the control-plane cache/counter/protection Redis; the BFF refreshes tokens itself. Session TTL is 30 days, aligned with the approved refresh contract, and logout performs backend logout (revoke the token family), deletes the session row, and clears the cookie. This retires ADR-0020's "no custom session store" clause together with the Clerk boundary it was part of.

Per live-grading request the BFF authorizes against current membership state by calling the caller-scoped roster with the user's own User Access JWT: sandbox Organization present means allow, absent means deny. The process-local five-minute decision cache ceiling is unchanged. A disabled account fails at token verification and a disabled membership fails by absence from the roster; both fail closed. No membership-introspection endpoint is added.

## Migration of existing Clerk data

An operator script inside aihub-be pulls users, memberships, and pending invitations from the Clerk Backend API. The evidence bundle — mapping table, quarantine list, run log — lives outside git; the repository carries only the runbook plus aggregate counts and a SHA-256 digest of the mapping file, because the mapping contains email addresses. The cutover has run and the script was removed in #337; the procedure is retained as a record in [Customer Web identity cutover runbook](../history/customer-web-identity-cutover.md), and git history retains the tool.

Matching keys on the normalized email: one exact active match reuses that account (duplicates are impossible by construction), no match pre-provisions a new account, and every ambiguous case — missing email, multiple candidates, a suspended or disabled target, or an unexpected existing membership row — enters quarantine for operator disposition (`link` / `create` / `skip`) that must be resolved before the flip. Migrated accounts are seeded `active` with an unusable random password; the first credential arrives through the password-reset path, whose delivered token re-proves email ownership. This deliberately departs from ADR-0022's pending-verification registration contract because this is operator-seeded migration, not registration.

For memberships the operator designates at least one owner before the flip (the zero-owner invariant must hold at every instant), disabled Clerk members become `disabled` rows, active members become `member`, and any row that does not match its planned shape is quarantined instead of overwritten. The script is idempotent by expected shape: a row that already matches the plan is a no-op, so rollback followed by re-flip neither duplicates data nor floods quarantine. Pending Clerk invitations are re-issued through the existing AIHUB invitation API at the flip instant — by the owner account, since invite tokens live only 24 hours — which sends the replacement emails from the application path.

## Email links and auth UI

A backend configuration names the Customer Web base URL. It remains optional outside the primary production app, where an unset value keeps the token-only email behavior. The production Customer Web URL must be absolute HTTPS. A separately deployed sandbox Customer Web can receive its own HTTPS URL; the API-only sandbox may leave it unset and keeps token-only emails until that UI exists. URLs may include a path prefix but not credentials, a query, or a fragment. When configured, verification, password-reset, and invitation emails gain deep links; issue #153 makes only the verification email link-first and removes its standalone token wording. The Customer Web UI ships sign-in, forgot/reset password, and invitation acceptance, and advertises public registration and Self-serve Organization creation, consistent with ADR-0041. Account registration creates a User Account only; creating an Organization is a separate action. The invitation-accept landing page still chains the ADR-0027 register → verify → login → accept flow.

## Google login handoff

Refresh cookies are host-bound and the browser never calls AIHUB directly, so Google login for the Customer Web uses a BFF handoff: the AIHUB callback redirects to an allowlisted Customer Web origin carrying a one-time, single-use, short-TTL, PKCE-bound authorization code — a code, not a token — and the BFF exchanges it server-side for the User Access JWT and refresh credential, storing both in the session row. The contract addition belongs to #93; the BFF side belongs to #94. Provider tokens never reach the browser, and the alternative of a second Google client inside the BFF is rejected because it would duplicate #93's validation outside AIHUB's control.

## Sandbox User ID continuity

Because the assertion subject derives from the verified identity, the issuer and subject change at the flip re-keys every migrated user's `cu_...` sandbox user_id exactly once. The old-to-new mapping is part of the migration evidence, so durable usage records keyed by the prior subject remain joinable offline; no schema change is required. "Stable" in CONTEXT.md therefore means stable within one identity era, and a documented migration with reviewed evidence may re-key once.

## Internal mode

The fixed-identity internal mode remains for local development only and fails closed when `NODE_ENV=production`; it is not part of the deployed identity path and cannot become a fail-open hole.

## Documentation effects and recorded conflict

At cutover, CONTEXT.md retires the Customer User and Managed IdP entries, keeps Clerk as a single historical line, and keeps Customer Organization; until cutover CONTEXT continues to describe Clerk as the active boundary and stays truthful to current state. The stale forward-looking Clerk sentences in ADR-0022 and ADR-0027 are annotated to point here.

**Recorded conflict:** issue #94's acceptance criteria ask that ADR-0021 be marked superseded. This decision amends only its identity clauses instead, because superseding it wholesale would silently drop its non-identity invariants — no-store grading, pass-through audio, the 90-second outer timeout, safe error mapping. The issue's acceptance criterion should be amended to match this record.

## Delivery

The Customer Web is the AiHub-Frontend repository, served at `aihubproduction.com`. The `aihub-sandbox-demo` repository named in an earlier draft was not restored; that separate demo keeps its own server-held Sandbox API key and is unaffected by the Customer Web's public registration and Self-serve Organization flow. Issue #94 tracks a two-repository checklist: aihub-be carries the email-link configuration, the Google handoff contract, the migration script, and these documents; AiHub-Frontend carries the session store, the auth UI, and the complete removal of Clerk. Pull requests in either repository reference #94.
