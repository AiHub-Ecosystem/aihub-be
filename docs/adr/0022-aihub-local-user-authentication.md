# ADR-0022: AIHUB-owned local user authentication alongside the sandbox identity boundary

- Status: Accepted

## Amendment for issue #64 (2026-09-19)

The first delivered slice is registration, email verification, and generic
verification resend only. It persists `user_accounts`, `auth_identities`, and
hash-only `email_verification_tokens` in Postgres. Passwords use Argon2id
(`m=65536,t=3,p=1`, 16-byte salt, 32-byte hash) and verification tokens use
opaque random values with SHA-256 hashes and a 24-hour expiry. Verification is
an atomic consume-plus-activation transition; resend consumes prior open
tokens before inserting one replacement. Resend delivery uses the typed
runtime-secret provider and the Resend adapter. Login, JWT, refresh, recovery,
and federation remain future slices and are not implied by this amendment.

AIHUB will own a local user-authentication plane for email/username/password registration, email verification, login, password recovery, and User Access JWT plus rotating Refresh Token issuance. Registration creates only an AIHUB User Account; Organization Membership and API-key provisioning remain separate, and access tokens do not pin a user to one organization. The existing Customer Web sandbox continues to use Clerk under ADR-0020 while this plane is introduced, and User Access JWTs do not replace the `X-API-Key` and User Assertion boundaries on grading routes. This keeps the new credential flow independently testable without breaking the running sandbox; a later migration may supersede the sandbox identity decision explicitly — [ADR-0046](0046-customer-web-aihub-auth-identity-boundary.md) is that migration, decided under issue #94.

The access token is an RS256 JWT with a `kid`, a 15-minute lifetime, and only issuer, audience, subject, token id, issued-at, and expiry claims. The refresh credential is opaque, stored only as a hash, delivered through a secure HttpOnly SameSite cookie, expires after 30 days, rotates on use, and revokes its token family on reuse. Registration returns a pending-verification account without tokens; verification and password reset use expiring opaque tokens, while login, refresh, logout, and recovery follow the agreed auth API contract.

The contract normalizes and uniquely constrains email and username, uses account states `pending_verification`, `active`, and `disabled`, and keeps membership state separate. Resend is the production email provider for verification and password-recovery messages, reached through the application-owned email port; its API key and sender configuration are runtime secrets/configuration. Auth failures use stable auth-specific error codes without exposing credential or account-existence details; login, registration, refresh, and recovery are rate-limited without permanent account lockout. Auth success responses use the shared `{ data, meta: { request_id } }` envelope, with no body for the agreed `204` operations.

## Amendment for issue #65 (2026-09-19)

The login slice is deliberately limited to a verified local email/password credential and a User Access JWT. Its success body is the shared envelope containing only `access_token`, `token_type: "Bearer"`, and `expires_in: 900`; Refresh Token cookie issuance remains the follow-up in issue #66. Unknown email, wrong password, pending-verification accounts, and disabled accounts share one safe credential-failure result, while malformed input and abuse limits retain their own boundary errors. Unknown identities still receive password-hash work so the login path does not become a simple account-enumeration oracle.

The User Access JWT uses RS256, requires a configured `kid`, and contains only `iss`, `aud`, `sub`, `jti`, `iat`, and `exp`. `iss` is the configured canonical AIHUB issuer, `aud` is `aihub-user-api`, and `sub` is the stable AIHUB User Account identifier; email, username, organization, membership, scopes, API-key data, and mutable credential state are not claims. Its signing material is a separate typed runtime-secret/configuration bundle, not the sandbox assertion or downstream internal-JWT key. Issue #65 provides a reusable Bearer verification boundary without changing the existing `X-API-Key` or `X-User-Assertion` grading boundaries and does not publish a JWKS endpoint.

Verification requires the RS256 algorithm, a non-empty `kid`, exact issuer and audience, a bounded `usr_...` subject, integer time claims, a maximum 900-second lifetime, and the existing 60-second clock-skew allowance. A validly signed token is still rejected when its User Account is no longer `active`; this is an authorization-time durable-state check rather than a jti blacklist. Missing and invalid Bearer credentials have separate safe `401` codes and a `WWW-Authenticate: Bearer` challenge, with no cryptographic detail exposed.

An inactive-account Bearer request uses the same invalid-token public code rather than exposing account state. The boundary accepts exactly one compact JWT from the `Authorization: Bearer` header, never a cookie or query parameter, and token responses are marked `Cache-Control: no-store`. Login reads one durable projection of the local Auth Identity and owning User Account (`userId`, status, password hash); organization membership is deliberately outside credential authentication. The evidence is a real HTTP application-injection suite with generated RS256 keys and fake durable/auth ports, covering claims, clock skew, malformed and wrong-algorithm tokens, inactive-after-login behavior, headers, OpenAPI, and unchanged grading authentication.

## Amendment for issue #153 (2026-09-23)

Verification email is link-first: its HTML part has a “Verify email” button and the plain-text part has the same full URL to the Customer Web `/verify-email` page, with the one-time token URL-encoded in the query and the expiry stated in both parts. The email does not print the verification token separately. The Customer Web page submits it through the existing `POST /v1/auth/verify-email` operation; there is no verifying `GET`, so a passive URL prefetch cannot activate the account. A scanner that executes the page and its JavaScript is outside that guarantee.

Production requires an absolute HTTPS Customer Web URL with no credentials, query, or fragment; an optional path prefix is allowed and trailing slashes are normalized. Non-production may leave the URL unset and retain token-only delivery, or use an absolute HTTP(S) URL. Production and sandbox deployments use their respective Customer Web URLs. Password-reset and organization-invitation email wording remains unchanged by this amendment.

## Amendment for issue #154 (2026-09-23)

Repeating verification succeeds only for the exact, unexpired token that activated the account, while the account remains `active`; it returns the same bodyless `204` as first verification. A token superseded by resend stays invalid, including after a later token activates the account. Persist a consumed reason such as `verified` or `superseded` alongside the token hash so this distinction survives without storing raw tokens. Disabled accounts, expired tokens, and unknown tokens remain invalid. Concurrent verify requests for the same token both acknowledge success; verify and resend serialize account-first, then token, so the winner determines whether resend is suppressed or the old token is invalidated. Cover these cases with real Postgres repository tests in the DB lane and an HTTP test, and publish the canonical `POST /v1/auth/verify-email` behavior in OpenAPI. The response remains bodyless and identical for first verification and allowed replay; no strict constant-time or wall-clock timing guarantee is added. Verification email copy explains that reopening the link after verification still shows success.
