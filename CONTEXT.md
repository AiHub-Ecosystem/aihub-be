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
- **Customer Organization:** the tenant concept in the Customer Web. During the invite-only sandbox MVP, all invited Customer Users belong to one Customer Organization mapped to the dedicated sandbox AIHUB Organization.
- **Managed IdP:** the external identity provider used by the existing Customer Web sandbox; it is separate from AIHUB's local credential auth and remains a future federation source for AIHUB accounts.
- **Clerk:** the selected Managed IdP for the existing Customer Web sandbox; it owns that sandbox's passwordless sign-in, invitations, organization membership, and session lifecycle.
- **Invite-only membership:** access granted by an operator to a known user; it remains the sandbox membership path, while local account registration does not grant Organization access.
- **Organization Membership:** the explicit relationship that grants an AIHUB User Account access to an Organization; it is separate from account registration and API-key issuance.
- **Email Verification:** proof that a User Account controls its registered email address; an unverified local account cannot complete login. Its opaque one-time verification token is invalidated when a newer token is issued.
- **Verification Token:** an opaque, single-use proof used by an Email Verification flow; only its hash is durable and the raw value is never logged or returned by an API response.
- **Password Recovery:** a time-limited proof-of-control flow that lets a User Account replace its local password without exposing the existing password.
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
- **Metering status:** the internal classification of usage evidence as complete, missing, not applicable, or unverified; `quota_unverified` specifically means quota admission was allowed while the quota counter was unavailable, and it is never exposed to API clients.
- **Billable request:** a successfully completed operation eligible for request-based billing; recorded failures remain non-billable evidence.
- **Monthly request quota:** the organization-scoped maximum number of billable requests in one UTC calendar month; `null` means unlimited and zero freezes billable work.
- **Quota counter:** the ephemeral count of billable requests for one organization and UTC month; it gates admission heuristically and is never the durable source of truth.
- **Quota reconciliation:** the periodic comparison that restores a quota counter from the durable billable request evidence for the same organization and UTC month; the durable evidence wins when the two disagree.
- **Usage retention:** the rolling 13-calendar-month window for durable metering records, measured from the UTC cutoff used by an operator run; records strictly older than the cutoff are eligible for pruning.
- **Retention cutoff:** the UTC instant captured for one usage-prune run; records at or after it remain retained, while records strictly before it are eligible.
- **Usage prune:** the operator maintenance action that removes expired metering records in bounded transactions; it is separate from quota reconciliation and idempotency cleanup.
- **Usage aggregate:** provider-reported input, output, and total token counts for an operation; AIHUB does not infer or estimate them.

## Ownership and invariants

- AIHUB owns the control plane: organization identity, API keys, scopes, metering, quota, idempotency, and routing policy.
- Durable metering records are retained for 13 calendar months across each deployment database; pruning applies to every outcome and never mutates Redis quota counters or idempotency records.
- Each usage-prune run captures one UTC retention cutoff with calendar month-end clamping; only records strictly before it are eligible, and production/sandbox failures are reported independently.
- AIHUB owns local credential authentication and User Access JWT issuance; the Customer Web may consume that identity through its BFF. External identity providers remain a future federation path, not part of the local credential flow.
- The existing sandbox Customer Web and Clerk flow remain in parallel while AIHUB local auth is introduced; this does not silently replace the sandbox identity boundary.
- Registration creates an AIHUB User Account only. It does not create an Organization, membership, or API key; access to an Organization is provisioned separately.
- Organization Membership is independent of registration, and a User Access JWT does not freeze a single organization because membership can change.
- Local registration requires email, username, and password, and the account must complete email verification before login succeeds.
- The local Auth Identity owns the normalized email/password credential, while the User Account owns the normalized unique Username; login uses the normalized email and registration does not grant Organization access.
- Local Account Status and Organization Membership status are evaluated at authorization time rather than assumed permanently from registration.
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
- Resolved as a future production cutover decision: the typed runtime-secret provider and Agent-file boundary are implemented, while Vault adoption remains deferred until the Stage A trigger is met. The agreed scope, KV v2 paths, AppRole/Vault Agent bootstrap, least-privilege policy, startup-only rotation, and fail-closed behavior are recorded in [ADR-0013](docs/adr/0013-vault-runtime-secret-management.md) and issue #30.
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
- Implemented: durable internal metering evidence, missing-usage classification, replay-safe request/token aggregates, and safe failure breadcrumbs; AI Services report aggregate token usage and `metrics.ai_processing_ms` only, while model identity is neither required nor exposed.
- Open, but not blocking: six fixes requested from the AI Writing team (chiefly aggregate usage and `metrics.ai_processing_ms`, which make token-based billing possible at all).

## Canonical documents

- [Contract](docs/aihub_deliverable_1_api_contract_schema.md)
- [AI Speaking D2 TSD](docs/contracts/aihub/ai-speaking-grading-proxy-tsd-v1.md)
- [ADR-0014: AI Speaking D2 contract boundary and evidence](docs/adr/0014-ai-speaking-d2-contract-boundary.md)
- [Spec index](docs/superpowers/specs/2026-09-07-aihub/README.md)
- [ADR-0016: Durable metering boundary and billing evidence](docs/adr/0016-metering-boundary-and-billing-evidence.md)
- [ADR-0023: Thirteen-month usage retention](docs/adr/0023-thirteen-month-usage-retention.md)
- [ADR-0020: Invite-only customer-web identity boundary for sandbox MVP](docs/adr/0020-customer-web-identity-boundary.md)
- [ADR-0021: Customer Web Speaking sandbox boundary](docs/adr/0021-customer-web-speaking-sandbox-boundary.md)
- [ADR-0022: AIHUB-owned local user authentication](docs/adr/0022-aihub-local-user-authentication.md)
- [Agent and architecture design](docs/superpowers/specs/2026-09-07-aihub/12-agent-workflow-and-clean-architecture-design.md)
- [Matt issue workflow](docs/agents/issue-tracker.md)
