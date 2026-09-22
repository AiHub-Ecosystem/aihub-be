# AIHUB Context

This is the short working index for agents. The full contract and architecture remain in the linked canonical documents.

## Purpose

AIHUB is a B2B multi-tenant AI API Gateway and identity broker. A client authenticates to AIHUB, AIHUB enforces organization policy and metering, then dispatches a typed operation to a private AI service. The active MVP slice is Writing grading.

## Vocabulary

- **Organization:** the tenant that owns API keys, identity configuration, quotas, usage, and downstream policy.
- **Customer Web:** the separate Next.js application through which invited people access the AIHUB demo; the existing sandbox uses Clerk, while future user-facing surfaces may consume AIHUB User Access JWTs through its BFF.
- **Customer User:** a person authenticated by the Customer Web; this is not an AIHUB account.
- **AIHUB User Account:** a credential-bearing account managed by AIHUB for user-facing access; it is distinct from an Organization and from the existing Customer User term until the Customer Web boundary is migrated.
- **Auth Identity:** a login identity attached to an AIHUB User Account, such as the Phase 1 local email/password identity or a future Google identity; it is not itself an Organization, API key, or username.
- **Username:** the normalized, unique account identifier owned by an AIHUB User Account; it is separate from the Auth Identity used to authenticate.
- **User Access JWT:** a short-lived RS256 token issued by AIHUB after local credential authentication for user-facing APIs or the Customer Web BFF; it is distinct from `X-API-Key`, User Assertions, and internal downstream JWTs, carries the User Account ID as `sub`, and does not carry organization or mutable credential data.
- **Bearer boundary:** the user-facing authentication boundary that accepts an AIHUB User Access JWT in `Authorization: Bearer`; it is separate from the `X-API-Key` and `X-User-Assertion` grading boundaries.
- **Refresh Token:** a renewable login credential paired with a User Access JWT; it can be rotated and revoked without changing the user account or API key.
- **Refresh Session:** the durable login session created by one successful login; it owns one Refresh Token Family and is independent from the User Account and User Access JWT.
- **Refresh Token Family:** the ordered lineage of rotated Refresh Token versions for one Refresh Session; reusing any previous version revokes the entire family.
- **Customer Organization:** the tenant concept in the Customer Web. During the invite-only sandbox MVP, all invited Customer Users belong to one Customer Organization mapped to the dedicated sandbox AIHUB Organization.
- **Managed IdP:** the external identity provider used by the existing Customer Web sandbox during the transition; it is separate from AIHUB's local credential auth and is not the target identity boundary for AIHUB accounts.
- **Clerk:** the current Managed IdP for the existing Customer Web sandbox; it owns that sandbox's passwordless sign-in, invitations, organization membership, and session lifecycle until [issue #94](https://github.com/AiHub-Ecosystem/aihub-be/issues/94) supersedes it.
- **Invite-only membership:** access granted by an operator to a known user; it remains the current sandbox membership path, while AIHUB local access uses explicit Organization Membership and local account registration does not grant Organization access.
- **Organization Membership:** the durable relationship that grants an AIHUB User Account access to an Organization; it is separate from account registration and API-key issuance, and one account may hold memberships in multiple Organizations. Removing access disables the relationship rather than deleting it.
- **Membership Role:** the per-organization authority assigned to a membership: `owner`, `admin`, or `member`; it is not a User Access JWT claim. Owners have full membership authority; admins may manage current members but not current owners or admins; members have no membership mutation authority.
- **Organization Invitation:** a pending, organization-scoped invitation for one normalized email; it is separate from a membership and becomes a membership only after the invited identity accepts. An invitation is open only while its token is unconsumed and unexpired; otherwise it is a closed invitation, whether accepted, superseded, expired, or revoked, without implying a separate public lifecycle status.
- **Organization Invite Token:** the opaque, single-use proof issued with an Organization Invitation; it is valid for 24 hours, only its hash is durable, and issuing a newer token for the same organization and normalized email invalidates the previous open token.
- **Organization Invitation Send Limit:** the policy that bounds new invitation-send attempts by inviting User Account, Organization, and normalized invited email; the email allowance is shared across Organizations, while the caller and Organization allowances remain independently scoped.
- **Management Idempotency Scope:** the replay boundary for one Organization mutation: one Organization, one AIHUB User Account, one mutation type, and one client-supplied key. Different Organizations and callers never share replay state.
- **Account Idempotency Scope:** the replay boundary for a mutation that has no Organization yet, such as creating one: one AIHUB User Account, one mutation type, and one client-supplied key. Different callers never share replay state.
- **Self-serve Organization:** an Organization an AIHUB User Account created through the Bearer boundary rather than one an operator provisioned; the creator becomes its first active `owner`, and its commercial terms start from operator-controlled defaults that only an operator may change.
- **Organization Creation Limit:** the lifetime number of Self-serve Organizations one AIHUB User Account may create; it counts creations, so suspending an Organization or transferring its ownership does not return an allowance.
- **Membership Status:** the lifecycle state of an Organization Membership: `active` or `disabled`; disabling preserves the durable relationship and does not physically delete it.
- **Organization Roster:** the read-only list of active memberships grouped by each Organization the caller actively belongs to; disabled memberships are not part of the current roster.
- **Organization Audit Event:** the immutable record of one organization control-plane act — the Organization's self-serve creation, or a membership, invitation, or API-key mutation that took effect, or a denied attempt against a real target. It names the acting AIHUB User Account, the Organization, the target, the action, the outcome, the originating request, and the moment; it never carries a credential, a token, or their hashes.
- **Audit action:** the enumerated name of a recorded act, such as an invitation sent or an API key rotated; only acts AIHUB can currently perform are nameable, so the set grows with the mutations that ship.
- **Organization Audit Read:** the Organization-scoped, newest-first view of Organization Audit Events for active owners and admins of the named Organization; it is paginated by an opaque cursor bound to the filters it was issued under, names the actor by immutable username, and carries no User Account ID, target identifier, or credential material.
- **Audit redaction:** the operator act that removes an Organization Audit Event's human-readable target label to satisfy an erasure request while leaving the event itself standing; it is the only permitted modification to a recorded event, which is otherwise append-only.
- **Email Verification:** proof that a User Account controls its registered email address; an unverified local account cannot complete login. Its opaque one-time verification token is invalidated when a newer token is issued.
- **Verification Token:** an opaque, single-use proof used by an Email Verification flow; only its hash is durable and the raw value is never logged or returned by an API response.
- **Password Recovery:** the generic flow through which an active local Auth Identity can receive a one-time proof to replace its password without exposing account existence or the existing password; it does not activate or re-enable an account.
- **Password Reset Token:** the opaque, single-use proof issued by Password Recovery; it is valid for one hour, only its hash is durable, and issuing a newer token invalidates the previous open token.
- **Local Account Status:** the lifecycle state of a local User Account: pending verification, active, or disabled.
- **Login credential failure:** the deliberately generic result for an unknown email, wrong password, pending-verification account, or disabled account; it does not reveal which account state was observed.
- **Sandbox User ID:** an opaque deterministic identifier derived from the verified Managed IdP issuer and subject, encoded to AIHUB's `[A-Za-z0-9_-]` boundary; it is never an email address or a browser-supplied value.
- **Server-side session:** a Customer Web session represented to the browser only by a secure, HttpOnly, same-site cookie; provider access tokens do not live in browser storage.
- **Sandbox API key:** the single server-held API key for the dedicated sandbox AIHUB Organization; it is used by the Customer Web BFF and is never sent to a browser.
- **Membership decision:** the active/disabled authorization result for a Customer User; the Customer Web evaluates it on every BFF request and may cache it for no more than five minutes in the sandbox MVP.
- **Per-request assertion:** a short-lived sandbox User Assertion minted immediately before one grading call; it is never persisted or reused for another request.
- **Pass-through audio:** uploaded Speaking audio streamed from the Customer Web BFF to AIHUB and discarded after the response; it is not an MVP audio asset.
- **Sandbox-only deployment:** the first Customer Web release is configured only for AIHUB's sandbox hostname and credential; Production is absent until the production bridge is approved.
- **Live grading:** an authenticated Speaking grading request that crosses the Customer Web BFF boundary; the anonymous mock preview is not live grading.
- **Mock preview:** an anonymous, non-AIHUB demonstration of the Speaking workflow and a sanitized sample result; it never consumes sandbox quota or performs live grading.
- **Speaking prompt:** a selectable IELTS question identified by a stable `question_id` and Part; the sandbox MVP uses a Customer Web prompt catalog rather than an AIHUB question service.
- **Customer Web BFF:** the server-side boundary that authenticates a Customer User, checks membership, and calls AIHUB; the browser never calls AIHUB directly.
- **Public grading result:** the normalized `{ data, meta }` envelope safe for the Customer Web; provider-only identifiers, timing, credentials, assertions, audio, and raw downstream detail are excluded.
- **API key:** an organization credential presented with `X-API-Key`; AIHUB stores only its SHA-256 hash and metadata.
- **Scope:** the permission an API key carries for one class of operation, written as `<entitlement>.<action>` such as `writing.grade`; the Operation Catalog owns the scope each public operation requires.
- **Entitlement:** the capability an Organization is licensed for, such as `writing` or `speaking`; it is the leading segment of a scope and bounds which scopes that Organization's keys may carry, so a scope outside the Organization's entitlements grants nothing.
- **API key status:** the lifecycle an API key is in — `active` while it may authenticate, `expired` once its expiry moment has passed, `revoked` once it has been withdrawn; expiry arrives on its own without anyone acting, revocation does not.
- **API key rotation:** replacing an API key's credential while preserving the authority it carried; the replacement is a new key, the old one is withdrawn in the same act, and no window exists in which both work.
- **Environment:** the request tier derived from its deployment hostname; an API key may be restricted to a set of allowed environments.
- **Sandbox environment:** AIHUB's fourth, hostname-bound request tier for controlled testing; it has its own sandbox organization, request-control configuration, Postgres database, Redis logical database, and application container while sharing downstream services and the deployment secret realm with production.
- **Deployment secret realm:** the environment scope used to select runtime credentials; `sandbox` is not a separate realm and sandbox traffic uses the enclosing deployment's credentials.
- **User Assertion:** a short-lived organization-signed assertion in `X-User-Assertion` for user-scoped operations.
- **Internal JWT:** a short-lived AIHUB-signed token used only on AIHUB-to-service calls.
- **Runtime secret:** a credential needed by a running service to call a dependency; it is not an API-key hash or a user assertion.
- **Machine identity:** the service identity used to access infrastructure such as Vault; it is distinct from end-user identity and User Assertion.
- **Secret source of truth:** Vault owns runtime secret values, while Postgres remains the durable source of truth for control-plane data such as API-key hashes.
- **AI Service:** a downstream domain service behind AIHUB, such as AI Writing or AI Speaking.
- **Model Provider:** an upstream foundational model service invoked by an AI Service; this term does not mean an AI Writing or AI Speaking service.
- **Usage-reporting declaration:** the current contract expectation for one AI Service to return complete token usage; it distinguishes an unreported value that is expected from missing evidence that is an anomaly, and can change independently per service.
- **Operation Catalog:** the typed code-owned mapping of public path, scope, identity mode, limits, timeout, and downstream operation.
- **Downstream Adapter:** a pure mapper between a public operation and a private AI service contract; it never performs network I/O.
- **Speaking grading proxy:** the synchronous D2 integration path used to prove the AI Speaking handoff; it is not the public async Speaking contract.
- **Approved audio URL:** an HTTPS reference to an audio object on the exact
  S3-compatible SeaweedFS origin `s3.wispace.app` approved for Speaking
  JSON-by-URL grading; it is not an arbitrary remote URL.
- **JSON-by-URL grading:** the synchronous Speaking grading transport that
  carries an approved audio URL; it is a fallback transport beside multipart
  grading, not the async grading job.
- **Speaking grading job:** the future durable async operation that accepts an organization-owned audio asset and returns a job result.
- **Audio asset:** an organization-owned reference to recorded audio; downstream URLs and partner credentials never become public request fields.
- **Metering record:** the durable internal evidence for one authenticated gateway request, used for usage, billing, and audit; it is not part of the public response.
- **Metering status:** the internal classification of usage evidence as complete, missing, not applicable, or unverified; `not_applicable` covers non-model or no-model-call requests and model-backed services without a reporting declaration, `missing_usage` is anomalous only for a service with a reporting declaration, and `quota_unverified` takes precedence when quota admission could not be verified. These statuses are never exposed to API clients.
- **Billable request:** a successfully completed operation eligible for request-based billing; recorded failures remain non-billable evidence.
- **Monthly request quota:** the organization-scoped maximum number of billable requests in one UTC calendar month; `null` means unlimited and zero freezes billable work.
- **Quota counter:** the ephemeral count of billable requests for one organization and UTC month; it gates admission heuristically and is never the durable source of truth.
- **Quota reconciliation:** the periodic comparison that restores a quota counter from the durable billable request evidence for the same organization and UTC month; the durable evidence wins when the two disagree.
- **Usage retention:** the rolling 13-calendar-month window for durable metering records, measured from the UTC cutoff used by an operator run; records strictly older than the cutoff are eligible for pruning.
- **Retention cutoff:** the UTC instant captured for one usage-prune run; records at or after it remain retained, while records strictly before it are eligible.
- **Usage prune:** the operator maintenance action that removes expired metering records in bounded transactions; it is separate from quota reconciliation and idempotency cleanup.
- **Usage aggregate:** provider-reported input, output, and total token counts for an operation; AIHUB does not infer or estimate them.
- **Usage completeness report:** a read-only operator view of missing usage evidence over a UTC window; it measures reporting health without changing customer requests or durable metering records.
- **Reporting-eligible operation:** a model-backed operation whose downstream AI Service has an enabled usage-reporting declaration; only its successful attempts participate in the completeness denominator and alert.
- **Usage report window:** the half-open UTC interval `[from, to)` selected for one completeness report; the same explicit window can be rerun deterministically.
- **Reporting activation:** the point at which a downstream's usage-reporting declaration becomes enabled; records before activation keep their original metering meaning and are not reclassified.
- **Incomplete usage rate:** missing-usage records divided by successful attempts for reporting-eligible operations in one report window; a zero denominator is healthy, not an alert.

## Ownership and invariants

- AIHUB owns the control plane: organization identity, API keys, scopes, metering, quota, idempotency, and routing policy.
- Durable metering records are retained for 13 calendar months across each deployment database; pruning applies to every outcome and never mutates Redis quota counters or idempotency records.
- Each usage-prune run captures one UTC retention cutoff with calendar month-end clamping; only records strictly before it are eligible, and production/sandbox failures are reported independently.
- AIHUB owns local credential authentication and User Access JWT issuance; the Customer Web may consume that identity through its BFF. External identity providers remain a future federation path, not part of the local credential flow.
- The existing sandbox Customer Web and Clerk flow remain in parallel while AIHUB local auth is introduced; [issue #94](https://github.com/AiHub-Ecosystem/aihub-be/issues/94) must supersede that boundary rather than silently replacing it.
- Registration creates an AIHUB User Account only. It does not create an Organization, membership, or API key; access to an Organization is provisioned separately.
- Organization Membership is independent of registration, and a User Access JWT does not freeze a single organization because membership can change.
- An AIHUB User Account may belong to multiple Organizations; management inputs carry an explicit `organizationId`, and authorization evaluates the selected membership at request time.
- Organization Membership roles are `owner`, `admin`, and `member`. Owners and admins may invite; admins cannot change or remove owners/admins; members cannot mutate membership or API keys.
- Membership mutations use the immutable public `username` as the target identifier. An admin may change or disable a target whose current role is `member`, including promoting that target to `admin`; only an owner may change or disable a current owner or admin.
- The membership mutation boundary uses `PATCH /v1/organizations/:organizationId/members/:username` with a role body for role changes and `DELETE` on the same resource to disable access. Both return the current membership in the shared success envelope; a disabled membership is not reactivated by these endpoints and invitation acceptance remains the reactivation path.
- Owner transfer is a dedicated atomic command: the target becomes `owner` and the initiating owner becomes `admin` in one transaction. A two-request promote/demote sequence is not a transfer substitute.
- The transfer command is the only path that promotes a membership to `owner`; ordinary role PATCH rejects `role: owner`. Membership disable affects Bearer membership/management authorization at the next check and does not change the separate `X-API-Key`, User Assertion, or downstream grading boundaries.
- Pending Organization Invitations are separate from memberships. At most one unconsumed invitation exists per organization and normalized email; resend invalidates the previous token, and acceptance uses the existing registration → verification → login path before creating or reactivating membership.
- Invitation sending is admitted only after caller authorization and email normalization: the configured limits are 5 attempts per 15 minutes per inviting User Account, 20 per 15 minutes per Organization, and 3 per 24 hours per normalized invited email shared across Organizations. The checks run in that order; a rejected attempt has no durable or delivery side effect and exposes only the generic rate-limited result, an idempotency replay spends no new allowance, and an email-delivery failure does not refund the attempt.
- The open-invitation view is read-only metadata for active owners and admins of the named Organization. It returns actionable pending invitations—unconsumed and unexpired at the request's received-at time—in deterministic order, identifies the issuer by immutable username, and never exposes account IDs, inviter email, invite tokens, or token hashes; members, non-members, disabled callers, and suspended Organizations receive the safe authorization denial. The initial view is intentionally unpaginated; measured invitation volume must justify a follow-up contract.
- The Organization Audit Read is open to active owners and admins of the named Organization; members, non-members, and disabled callers receive one indistinguishable authorization denial. A suspended Organization stays readable, deliberately unlike the open-invitation and API-key listings: those are management surfaces that suspension should close, while the trail is evidence, and refusing it would erase the record exactly when a suspended Organization's owner needs it ([ADR-0040](docs/adr/0040-organization-audit-read-boundary.md)). Results are newest-first over `(occurred_at, id)` and paginated by an opaque cursor bound to its filters; a page size outside its range and a window bound that is not a canonical UTC instant are rejected rather than clamped or coerced.
- Invitation listing is a point-in-time view: a concurrent acceptance or resend may complete after the read begins, and the next read reflects that durable change. A malformed invitation or issuer projection fails the whole view rather than returning partial metadata; a disabled issuer remains attributable by immutable username, and public `pending` is the projection of actionable state rather than a new lifecycle status.
- Invitation revocation is an organization-scoped control action: owners may close an invitation for any Membership Role, while admins may close only invitations granting `member`; members, non-members, disabled callers, and suspended Organizations receive the safe policy denial. For a caller with invitation authority, an unknown or foreign invitation is `NOT_FOUND`; an already-closed invitation is a retry-safe no-op. Revocation closes the existing invitation record, does not create a new lifecycle status, and records an applied Organization Audit Event only when an open invitation is actually closed ([ADR-0036](docs/adr/0036-organization-invitation-revocation-boundary.md)).
- Inviting an active member is a conflict; resending an open invitation replaces its token; inviting a disabled membership creates a new invitation that can reactivate it. Acceptance rejects disabled accounts, suspended organizations, and revoked or replayed tokens without consuming a still-valid token, and consumes the token only with membership creation/reactivation.
- Accepting an Organization Invitation is the only path that turns one into an Organization Membership; the invited email must match the accepting account's normalized email. A reactivated membership takes the role named by the invitation, while an already-active membership keeps the role it has: acceptance never changes an active member's authority.
- Organization Membership uses `active`/`disabled` state without physical deletion. An organization may have multiple owners, but removal or demotion of the last owner is rejected; transfer operations are atomic.
- A member may disable their own membership; an owner may self-demote or self-disable only when another owner remains. Self-promotion is not allowed. Role and disable commands are state-idempotent, so repeating an already-applied state is successful without a separate idempotency record.
- Mutation errors use `403` for caller/organization policy denial, `404` for an unknown or cross-organization target, and `409` for a zero-owner conflict; successful retries return the resulting durable membership state.
- Membership role/status changes serialize the organization and relevant membership rows in one durable transaction; the zero-owner invariant is enforced there rather than by a database trigger. These mutation semantics are recorded in [ADR-0029](docs/adr/0029-organization-membership-mutation-boundary.md).
- Every membership, invitation, and API-key mutation that changes durable state records an Organization Audit Event in the same durable act; a failed audit write fails the mutation, so no change commits without its record. These semantics are recorded in [ADR-0035](docs/adr/0035-organization-audit-trail-boundary.md).
- Denied attempts are recorded only when the caller actively belongs to the named Organization and the target is real: insufficient authority and the zero-owner conflict are recorded, while unknown targets, cross-organization targets, state-idempotent repeats, and idempotency replays are not. A denial's own record is written outside the mutation's durable act, and failing to write it still returns the original denial rather than an internal failure.
- Organization Audit Events are append-only and retained for 24 calendar months. Audit redaction is the only permitted modification, and no event carries an API key, invite token, password, signed assertion, raw request or downstream body, or a stored hash of any of them.
- Active owners, admins, and members may read a redacted Organization Roster; membership mutations remain restricted by the role authority in ADR-0027.
- The self-roster groups Organizations and exposes only public organization identity plus member username and role; it does not expose email addresses, auth identities, tokens, or User Account IDs. A valid account with no active memberships receives an empty roster.
- A suspended Organization may remain visible in a caller's read-only roster, while disabled memberships are excluded; membership and API-key mutations remain blocked for suspended Organizations.
- Membership authorization resolves the explicit User Account/Organization relationship at request time without an indefinite cache; missing or disabled membership denies access, while a durable lookup failure returns a safe internal failure without authorizing.
- Authorization projections include the Organization lifecycle status internally; suspended Organizations remain readable through the self-roster but reject future membership and API-key mutations.
- Invalid membership or organization projections fail the whole roster request with a safe internal error; the API never returns a partial roster or silently skips corrupt rows.
- Membership authorization keeps internal denial reasons distinct for policy and tests but maps missing and disabled access to the same public forbidden response.
- The initial self-roster uses one consistent database snapshot and deterministic ordering; it is intentionally unpaginated until roster size requires a follow-up contract.
- Username is the immutable public member identifier for the MVP roster; a future rename policy must introduce a separate public handle rather than exposing a User Account ID.
- Membership status changes use `updated_at` for the current durable state; disable actor, reason, and historical audit events remain outside this slice and belong with the durable audit follow-up.
- A suspended Organization rejects membership and API-key mutations and invite acceptance. An AIHUB User Account may create a Self-serve Organization and becomes its first active owner in the same durable act; the request carries only a name, never commercial terms, and the Organization Creation Limit bounds how many one account may create. This supersedes the operator-only provisioning recorded in ADR-0027.
- Organization API keys are organization-owned. Owners and admins may create, list, rotate, and revoke them; lists expose metadata only, rotation immediately revokes the old key and returns the raw replacement once, and no customer-facing grace window exists.
- Invite mutations reuse the existing idempotency seam. API-key creation and rotation do not: that seam persists the response body, and replaying a response that carries a raw credential would make the credential durable. Redis cache-purge failure can retain the existing operational cache ceiling of up to 60 seconds; this is not an intentional customer grace period.
- Google federation is outside the membership decision and is tracked in [issue #93](https://github.com/AiHub-Ecosystem/aihub-be/issues/93); it must attach an Auth Identity to an existing User Account without creating organization access implicitly.
- Local registration requires email, username, and password, and the account must complete email verification before login succeeds.
- The local Auth Identity owns the normalized email/password credential, while the User Account owns the normalized unique Username; login uses the normalized email and registration does not grant Organization access.
- Local Account Status and Organization Membership status are evaluated at authorization time rather than assumed permanently from registration.
- Password Recovery is eligible only for an active local password Auth Identity; pending-verification and disabled accounts receive the same generic recovery response but no reset credential, and recovery never changes account status.
- Password Reset Tokens have a lifecycle separate from Email Verification tokens: one open token per account, one-hour expiry, hash-only durability, and invalidation when a newer token is issued.
- A valid, rate-allowed recovery request returns the same generic `202` response for known and unknown addresses; Resend delivery failures are swallowed at the public boundary, while malformed, rate-limited, and durable-storage failures retain their respective safe errors.
- Password reset rechecks that the account is active when the token is consumed; a later disablement makes the token unusable and does not change the account or sessions.
- Reset success is one durable transaction: consume the presented token, replace the password hash, invalidate other open reset tokens, and revoke every Refresh Token Family. Concurrent reset attempts have one winner; losers receive the generic invalid-token result without partial changes.
- A reset-token row remains usable when Resend reports a delivery failure so a late provider delivery can still succeed; a later recovery request replaces it. Expired and consumed reset rows remain durable until a later bounded cleanup concern.
- Successful password reset returns bodyless `204` with `Cache-Control: no-store` and clears the current refresh cookie; all access JWTs remain limited by their existing short lifetime.
- Login returns a User Access JWT and a Refresh Token. The local credential is one Auth Identity, and future Google sign-in must attach to the same User Account rather than silently creating duplicates.
- The #65 login slice returns only a 15-minute User Access JWT in the shared success envelope; #66 adds the secure Refresh Token cookie and rotation without changing the access-token body contract.
- User Access JWTs contain exactly `iss`, `aud`, `sub`, `jti`, `iat`, and `exp`; `iss` is the configured canonical AIHUB issuer, `aud` is `aihub-user-api`, and `sub` is the stable `AIHUB User Account` ID, while email, username, organization, membership, scopes, API-key data, and credential state remain outside the token.
- User Access JWT signing material is a separate RS256 runtime-secret/configuration bundle with a required `kid`; the #65 slice does not publish a JWKS endpoint or reuse sandbox/assertion/internal-JWT keys.
- User Access JWT verification requires RS256, a non-empty `kid`, exact issuer and audience, bounded `usr_...` subject, integer time claims, a maximum 900-second lifetime, and the shared 60-second clock-skew allowance; `jti` is not persisted for revocation in this slice.
- A Bearer request must resolve an `active` AIHUB User Account at authorization time; disabling an account invalidates its still-signed access tokens immediately without introducing a token blacklist.
- Missing and invalid Bearer credentials use separate safe `401` auth errors and a `WWW-Authenticate: Bearer` challenge; cryptographic failure details never enter the public response.
- An inactive account presented with an otherwise valid User Access JWT maps to the same invalid-Bearer error; no account-state-specific public code is added.
- The User Access JWT response is `Cache-Control: no-store`; the #65 boundary accepts one compact token from the Bearer header only, never a cookie, query parameter, or duplicate header.
- Login reads one durable projection of Auth Identity plus its owning User Account (`userId`, status, password hash); organization membership is not part of credential authentication.
- User Access JWTs authenticate user-facing/BFF boundaries; grading routes continue to use the organization API-key and user-assertion boundaries until a separate authorization decision changes them.
- Refresh Tokens are renewable credentials with explicit rotation and revocation; they are not interchangeable with API keys or User Access JWTs.
- Each successful login creates a separate Refresh Session and Token Family; logout revokes only the family represented by the current cookie, so another login remains independent.
- The #66 slice treats the refresh cookie as an AIHUB-hosted, host-only, `Secure`/`HttpOnly`/`SameSite=Strict` browser credential; cross-site BFF forwarding and its CSRF contract are deferred.
- The refresh cookie is named `__Host-aihub_refresh`, uses `Path=/` with no `Domain`, lives for 30 days, and is cleared with the same attributes plus immediate expiry.
- Refresh credentials are cookie-only: refresh accepts exactly one named cookie and an empty body, never an authorization header, query value, alternate cookie, or duplicate cookie name.
- Each successful refresh issues a new opaque 32-byte CSPRNG credential with a new 30-day sliding expiry; only its SHA-256 hash is durable, and refresh credentials use a port distinct from verification tokens.
- Durable refresh state stores one row per token version in Postgres, retaining its family lineage and used/revoked/expiry state; Redis is not a refresh-session source of truth.
- The durable model uses one refresh-token table: `family_id` is the logical Refresh Session identifier, while each row carries its token version and lifecycle timestamps; there is no separate session-parent table until session management needs one.
- The refresh-token migration uses `rft_` token IDs and `rfs_` family IDs, unique hash plus user/family indexes, and no `replaced_by_id` or parent session table; existing accounts are not backfilled.
- Login fails closed when the durable Refresh Session cannot be created, so no access token or refresh cookie is returned without a persisted session.
- Refresh rotation commits the durable session change before issuing the new access JWT; an issuer failure returns a safe `5xx` without credentials and requires a new login.
- Refresh rotation is strict and atomic: a second use of an already-rotated token is reuse, revokes its entire family, and receives the same generic refresh failure as every other invalid refresh credential; no replay grace window exists.
- Refresh requires an active User Account; a disabled account cannot refresh, while account status remains the live authorization gate rather than a new token blacklist or automatic family purge.
- Refresh failures are intentionally generic `401` results, and logout is idempotent: it clears the cookie and returns bodyless `204` even when the cookie is absent or invalid.
- Refresh failures use `refresh_ip` at 20 failures per 5 minutes and `refresh_token` at 5 failures per 15 minutes through the existing application rate-limit seam; missing cookies use only the IP dimension, successful refreshes never increment or reset counters, and no permanent account lockout exists.
- A valid token row is locked, checked for active account and expiry, marked used, and followed by a successor row; a used or revoked token revokes its family before returning the generic refresh failure. Logout revokes a known token's whole family even when that token is already stale.
- Login issues the access JWT before creating its Refresh Session but returns neither JWT nor cookie unless both succeed; a failed persistence step is a safe login failure.
- Refresh returns the same `200` access-token envelope as login with `Cache-Control: no-store`; logout returns bodyless `204` with a cleared cookie and `Cache-Control: no-store`. Public refresh failures use only `AUTH_REFRESH_TOKEN_INVALID`; internal diagnostics may classify the reason without exposing it.
- A definitive refresh credential failure clears the refresh cookie; rate-limit and infrastructure failures preserve it for retry. Refresh accepts no body or `{}`, rejects non-empty bodies and alternate credential sources, and treats duplicate cookie names as invalid.
- Expiry uses an injectable clock and the strict boundary `expires_at > now`; lifecycle updates and successor insertion are one atomic transition, while infrastructure failures do not consume credential-failure limits.
- Expired and revoked rows remain durable for audit and reuse decisions; bounded cleanup is a later maintenance concern, not part of #66.
- Cookie value parsing and serialization belong to the Fastify cookie boundary; because that parser collapses duplicate names, the boundary may inspect raw header metadata only to reject duplicate `__Host-aihub_refresh` names, never to extract a credential.
- OpenAPI and Postman artifacts describe the cookie, `Set-Cookie`, refresh `200`, logout `204`, and generic refresh `401`; HTTP integration uses an in-memory durable seam and an injectable clock.
- The refresh implementation extends the local-auth repository port and uses a separate refresh-token issuer port; schema changes arrive through an explicit migration before code deployment, never through bootstrap DDL.
- The acceptance evidence covers cookie attributes, unchanged login body, successful rotation, reuse-family revocation, concurrent refresh, expiry, disabled accounts, malformed/duplicate/alternate sources, independent login families, logout idempotency, rate-limit fallback, transaction behavior, artifacts, and secret redaction.
- During the sandbox MVP, one dedicated sandbox AIHUB Organization serves all invited Customer Users, each with a stable sandbox `user_id`; users cannot switch organizations.
- The existing sandbox Managed IdP owns invitation and disable actions; the Customer Web checks active membership on every BFF request rather than trusting a stale session alone.
- The existing sandbox Managed IdP directory is the membership source of truth for that sandbox; local AIHUB accounts use their own account and membership records.
- The Customer Web derives the Sandbox User ID from the verified IdP identity; clients cannot choose the assertion subject or sandbox `user_id`.
- The Customer Web BFF holds one Sandbox API key server-side and relies on the sandbox environment's global quota, rate, and concurrency limits while live grading remains invite-only.
- The BFF mints a Per-request assertion immediately before grading and discards it after the call; it never persists assertions or Pass-through audio.
- Speaking grading is one attempt per user action with no automatic retry; the UI shows a safe error and AIHUB request ID, while logs contain only opaque identifiers, codes, and timing.
- The first Customer Web release uses Clerk, no custom session store, a deployment secret for the operator-managed Sandbox API key, and fixed server-side mapping to the dedicated sandbox organization.
- The first Customer Web release is Sandbox-only; Production configuration is absent until the production organization bridge is approved.
- IdP invitation links are one-time and provider-expiring; resending an invitation invalidates the previous link, and the Customer Web does not mint invite tokens.
- A disabled user loses Live grading access on the next membership decision within the five-minute cache ceiling; the mock preview remains available.
- The BFF rejects audio above the 25 MiB boundary before forwarding, aborts an in-flight upstream stream when the client disconnects, and never stores the audio.
- Logout invalidates the session for subsequent Live grading requests across tabs; no browser-side token cleanup is treated as authorization.
- The Customer Web UI and BFF share one origin; the browser never calls AIHUB directly. BFF mutations require secure cookie handling and same-origin checks.
- Logout clears the Customer Web session and invokes the Managed IdP logout path. Login, membership, and credential-mint failures fail closed; the anonymous mock preview remains available.
- The Mock preview never calls AIHUB and remains available without a Customer User; Live grading uses the same Speaking surface only after active membership succeeds.
- The Customer Web owns the sandbox Speaking prompt catalog; AIHUB's removed question-generation routes are not recreated for the Customer Web demo.
- Mock and Live grading share one Public grading result renderer; the browser receives only normalized public data and never sees provider-shaped private fields.
- The Customer Web Speaking slice accepts upload and browser recording as Pass-through audio, sends multipart grading through the Customer Web BFF, and does not add object storage or JSON-by-URL transport.
- The Speaking surface uses explicit user retry only, aborts disconnected requests, and keeps an outer 90-second timeout so it does not pre-empt the approved D2 deadline or upload/response transit.
- The Customer Web BFF preserves AIHUB's public Speaking error status, code, safe message, and request ID, mapping only local identity/configuration/transport failures and never returning raw upstream detail.
- Sandbox Customer Web configuration fails closed unless it targets the approved sandbox host; Production configuration is not a valid fallback for this surface.
- Live Speaking requests and results are no-store, use correlation IDs for diagnostics, and never become browser or server audio history.
- The Customer Web validates the public grading envelope before rendering; an unrecognized normalized response is a safe contract error, not a guessed UI state.
- Each AI service owns its business data and model-specific behavior.
- `organizationId` is explicit in request context and application ports.
- The D2 Speaking grading proxy authenticates the client at AIHUB; downstream partner credentials remain server-side configuration.
- Downstream Speaking `user_id` comes from the verified user assertion, never from an untrusted client identity field.
- D2 Speaking proxy responses use the shared `{ data, meta }` envelope; raw downstream bodies are not public responses.
- Controllers are thin; application ports hide infrastructure; domain code is framework-free.
- Redis is ephemeral protection/cache state, never durable source of truth.
- Secrets, assertions, internal tokens, essays, and raw downstream bodies never enter logs.

## Current scope and blockers

- Current scope: one NestJS/Fastify app, the Writing grading vertical slice, and the D2 AI Speaking proxy proof-of-forwarding across Dev and Production. The D2 handoff also includes multipart grading plus the JSON-by-URL fallback, a test-client flow, and a TSD aligned with the AI Speaking service owner and WISPACE.
- Implemented: Writing Task 1/Task 2 grading (`/task1/grade`, `/task2/grade`) validates the public request, authenticates API keys against Postgres, uses Redis for credential caching and rate limiting, dispatches through typed Writing adapters, and returns the `{ data, meta }` envelope. AIHUB question-generation routes and adapters were removed on 2026-09-12; upstream private service endpoints are outside this gateway. The D2 Speaking proxy now has multipart and JSON-by-URL routes (`POST /v1/ielts/speaking/grading` and `POST /v1/ielts/speaking/grading-json`), derives downstream user identity from the verified assertion, validates the approved audio URL boundary, dispatches through typed Speaking adapters, and maps the redacted common response/error fixture. The authenticated Production multipart smoke is accepted as the Dev-compatibility gate substitute; AI Speaking service/WISPACE approved the baseline TSD on 2026-09-14. Local Postgres/Redis E2E verification passed on 2026-09-07.
- Deferred: the public Speaking grading job, object storage/presigned audio uploads, async workers and job polling, Reading, billing, dynamic routing, Kubernetes, and a dedicated proxy.
- Resolved: production uses the typed runtime-secret provider plus Vault Agent connection snapshots for downstream credentials, database/Redis URLs, and sandbox signing material. AppRole is least-privilege and startup-only; production fails closed without both rendered files. The scope, KV paths, bootstrap, rotation, rollback, and file-permission contract are recorded in [ADR-0013](docs/adr/0013-vault-runtime-secret-management.md) and issue #30.
- Resolved for D2: the AI Speaking service remains a synchronous downstream integration (multipart grading is the primary path; JSON-by-URL is a fallback). AIHUB exposes the two synchronous proxy transports under the `/v1/ielts/speaking/*` namespace while keeping the future public Speaking operation asynchronous; the D2 proxy must not silently redefine that async contract.
- Resolved D2 contract: the sync proxy route is `POST /v1/ielts/speaking/grading`, distinct from the future async `POST /v1/speaking/grade`. It accepts multipart audio with explicit `part` and `question_id`; the wire-body ceiling is 26 MiB around a 25 MiB audio-file cap mirroring the provider contract, the upload-plus-grading deadline is 60 seconds, `user_id` is server-derived, Speaking has no idempotent replay, and downstream AI Service errors are mapped into shared AIHUB errors rather than passed through.
- Known Speaking follow-ups: the Production handoff smoke is verified for both synchronous transports; keep the provider-owned no-redirect, 25 MiB download, and 30-second guarantees under the AI Speaking contract, then decide when to promote the proxy into the async asset/job flow.
- Next D2/D3 follow-up: expand the proxy to the remaining AI Service endpoints, validate the Production routes with Postman, and publish a per-endpoint TSD without creating a second contract vocabulary.
- No AIHUB infrastructure or contract-approval blockers remain. On 2026-09-15,
  authenticated Production smoke covered multipart success, JSON-by-URL success
  with a real `s3.wispace.app` WAV object, missing credentials, missing metadata,
  and the multipart size boundary. The gateway returned the expected shared
  statuses/envelopes and dropped provider-only telemetry. No-redirect,
  downloaded-audio ceiling, and downstream deadline behavior remain provider-owned
  guarantees recorded in the approved contract; #25 is the Production handoff
  record and #28 is closed after the JSON smoke evidence.
- Resolved: the Writing grading response contract. Both retained grading endpoints were called against the live service; captured responses are committed under `test/fixtures/ai-writing/` and the shared grading parser is implemented and tested. Catalog response contracts are real schemas, not `unresolved`.
- Resolved as a decision, not as work: AI Writing stays reachable from the internet for now, because it still serves an application that does not go through AIHUB. The boundary at this stage is the credential, not the network — AIHUB customers hold only AIHUB keys, so metering and limits still bind them. Three conditions keep that acceptable; see the security spec.
- Resolved: Deliverable 1 is frozen as of 2026-09-07 — the OpenAPI 3.1 spec (`openapi.json`) and the Postman handover collection (`aihub.postman_collection.json`) are both generated from source, not hand-written.
- Implemented: idempotency replay for completed successful attempts, the ErrorCode→httpStatus registry, and the public API docs page at `/docs` (with the raw spec at `/openapi.json`).
- Implemented: durable internal metering evidence, missing-usage classification, replay-safe request/token aggregates, and safe failure breadcrumbs; AI Services are expected to report aggregate token usage and `metrics.ai_processing_ms`, but current provider contracts may not yet do so, while model identity is neither required nor exposed.
- Open, but not blocking: six fixes requested from the AI Writing team (chiefly aggregate usage and `metrics.ai_processing_ms`, which make token-based billing possible at all).

## Canonical documents

- [Contract](docs/aihub_deliverable_1_api_contract_schema.md)
- [AI Speaking D2 TSD](docs/contracts/aihub/ai-speaking-grading-proxy-tsd-v1.md)
- [ADR-0014: AI Speaking D2 contract boundary and evidence](docs/adr/0014-ai-speaking-d2-contract-boundary.md)
- [Spec index](docs/superpowers/specs/2026-09-07-aihub/README.md)
- [ADR-0016: Durable metering boundary and billing evidence](docs/adr/0016-metering-boundary-and-billing-evidence.md)
- [ADR-0026: CLI boundary for usage completeness reporting](docs/adr/0026-usage-completeness-report-boundary.md)
- [ADR-0023: Thirteen-month usage retention](docs/adr/0023-thirteen-month-usage-retention.md)
- [Usage completeness report runbook](docs/operations/usage-completeness.md)
- [ADR-0020: Invite-only customer-web identity boundary for sandbox MVP](docs/adr/0020-customer-web-identity-boundary.md)
- [ADR-0021: Customer Web Speaking sandbox boundary](docs/adr/0021-customer-web-speaking-sandbox-boundary.md)
- [ADR-0022: AIHUB-owned local user authentication](docs/adr/0022-aihub-local-user-authentication.md)
- [ADR-0027: Organization membership, invitation, and API-key self-service boundary](docs/adr/0027-organization-membership-and-key-management.md)
- [ADR-0028: Organization roster read boundary](docs/adr/0028-organization-roster-read-boundary.md)
- [ADR-0029: Organization membership mutation boundary](docs/adr/0029-organization-membership-mutation-boundary.md)
- [ADR-0039: Organization invitation send-rate boundary](docs/adr/0039-organization-invitation-send-rate-boundary.md)
- [ADR-0024: Rotating refresh-session boundary](docs/adr/0024-rotating-refresh-session-boundary.md)
- [Agent and architecture design](docs/superpowers/specs/2026-09-07-aihub/12-agent-workflow-and-clean-architecture-design.md)
- [Matt issue workflow](docs/agents/issue-tracker.md)
- [Follow-up issue #92: durable audit trail for organization membership and API-key mutations](https://github.com/AiHub-Ecosystem/aihub-be/issues/92)
- [Follow-up issue #93: Google OIDC login for AIHUB User Accounts](https://github.com/AiHub-Ecosystem/aihub-be/issues/93)
- [Follow-up issue #94: migrate Customer Web identity boundary off Clerk](https://github.com/AiHub-Ecosystem/aihub-be/issues/94)
