# AIHUB Context

This is the short working index for agents. The full contract and architecture remain in the linked canonical documents.

## Purpose

AIHUB is a B2B multi-tenant AI API Gateway and identity broker. A client authenticates to AIHUB, AIHUB enforces organization policy and metering, then dispatches a typed operation to a private AI service. The active MVP slice is Writing grading.

## Vocabulary

- **Organization:** the tenant that owns API keys, identity configuration, quotas, usage, and downstream policy.
- **API key:** an organization credential presented with `X-API-Key`; AIHUB stores only its SHA-256 hash and metadata.
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
- **Metering status:** the internal classification of usage evidence as complete, missing, not applicable, or unverified; it is never exposed to API clients.
- **Billable request:** a successfully completed operation eligible for request-based billing; recorded failures remain non-billable evidence.
- **Usage aggregate:** provider-reported input, output, and total token counts for an operation; AIHUB does not infer or estimate them.

## Ownership and invariants

- AIHUB owns the control plane: organization identity, API keys, scopes, metering, quota, idempotency, and routing policy.
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
- Resolved D2 contract: the sync proxy route is `POST /v1/ielts/speaking/grading`, distinct from the future async `POST /v1/speaking/grade`. It accepts multipart audio with explicit `part` and `question_id`; the total wire-body ceiling is 25 MiB, `user_id` is server-derived, Speaking has no idempotent replay, and downstream AI Service errors are mapped into shared AIHUB errors rather than passed through.
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
- Implemented: durable internal metering evidence, missing-usage classification, replay-safe request/token aggregates, and safe failure breadcrumbs; public response usage/model exposure remains a separate decision.
- Open, but not blocking: six fixes requested from the AI Writing team (chiefly usage metadata, which is what makes token-based billing possible at all).

## Canonical documents

- [Contract](docs/aihub_deliverable_1_api_contract_schema.md)
- [AI Speaking D2 TSD](docs/contracts/aihub/ai-speaking-grading-proxy-tsd-v1.md)
- [ADR-0014: AI Speaking D2 contract boundary and evidence](docs/adr/0014-ai-speaking-d2-contract-boundary.md)
- [Spec index](docs/superpowers/specs/2026-09-07-aihub/README.md)
- [ADR-0016: Durable metering boundary and billing evidence](docs/adr/0016-metering-boundary-and-billing-evidence.md)
- [Agent and architecture design](docs/superpowers/specs/2026-09-07-aihub/12-agent-workflow-and-clean-architecture-design.md)
- [Matt issue workflow](docs/agents/issue-tracker.md)
