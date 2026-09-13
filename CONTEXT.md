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
- **Operation Catalog:** the typed code-owned mapping of public path, scope, identity mode, limits, timeout, and downstream operation.
- **Downstream Adapter:** a pure mapper between a public operation and a private AI service contract; it never performs network I/O.
- **Speaking grading proxy:** the synchronous D2 integration path used to prove the AI Speaking handoff; it is not the public async Speaking contract.
- **Speaking grading job:** the future durable async operation that accepts an organization-owned audio asset and returns a job result.
- **Audio asset:** an organization-owned reference to recorded audio; downstream URLs and partner credentials never become public request fields.

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

- Current scope: one NestJS/Fastify app, the Writing grading vertical slice, and the D2 AI Speaking proxy proof-of-forwarding across Dev and Production. The D2 handoff also includes a test-client flow and a ten-section TSD aligned with the Provider and WISPACE.
- Implemented: Writing Task 1/Task 2 grading (`/task1/grade`, `/task2/grade`) validates the public request, authenticates API keys against Postgres, uses Redis for credential caching and rate limiting, dispatches through typed Writing adapters, and returns the `{ data, meta }` envelope. AIHUB question-generation routes and adapters were removed on 2026-09-12; upstream private service endpoints are outside this gateway. The D2 Speaking Dev proxy (`POST /v1/speaking/grading`) validates bounded multipart input, derives provider identity from the verified assertion, dispatches through the typed Speaking adapter, and maps a redacted live provider response/error fixture. Provider/WISPACE approval and Dev-specific compatibility verification remain pending. Local Postgres/Redis E2E verification passed on 2026-09-07.
- Deferred: the public Speaking grading job, object storage/presigned audio uploads, async workers and job polling, Reading, billing, dynamic routing, Kubernetes, and a dedicated proxy.
- Resolved as a future production cutover decision: the typed runtime-secret provider and Agent-file boundary are implemented, while Vault adoption remains deferred until the Stage A trigger is met. The agreed scope, KV v2 paths, AppRole/Vault Agent bootstrap, least-privilege policy, startup-only rotation, and fail-closed behavior are recorded in [ADR-0013](docs/adr/0013-vault-runtime-secret-management.md) and issue #30.
- Resolved for D2: the AI Speaking service remains a synchronous downstream integration (multipart grading is the primary documented path; JSON-by-URL is a fallback). AIHUB keeps the previously frozen public Speaking operation asynchronous; the D2 proxy is a testable integration boundary and must not silently redefine that public contract.
- Resolved D2 contract: the sync proxy route is `POST /v1/speaking/grading`, distinct from the future async `POST /v1/speaking/grade`. It accepts multipart audio with explicit `part` and `question_id`; `user_id` is server-derived, the D2 audio ceiling is 25 MB, and provider errors are mapped into shared AIHUB errors rather than passed through.
- Known Speaking follow-ups: capture an authenticated live success fixture, confirm the prototype endpoint/path and downstream credential configuration, freeze the normalized result/error mapping, test the local client against Dev and Production, align the TSD with the Provider and WISPACE, and then decide when to promote the proxy into the async asset/job flow.
- Next D2/D3 follow-up: expand the proxy to the remaining AI Provider endpoints, validate the Production routes with Postman, and publish a per-endpoint TSD without creating a second contract vocabulary.
- No blockers. Both earlier ones were resolved on 2026-09-07.
- Resolved: the Writing grading response contract. Both retained grading endpoints were called against the live service; captured responses are committed under `test/fixtures/ai-writing/` and the shared grading parser is implemented and tested. Catalog response contracts are real schemas, not `unresolved`.
- Resolved as a decision, not as work: AI Writing stays reachable from the internet for now, because it still serves an application that does not go through AIHUB. The boundary at this stage is the credential, not the network — AIHUB customers hold only AIHUB keys, so metering and limits still bind them. Three conditions keep that acceptable; see the security spec.
- Resolved: Deliverable 1 is frozen as of 2026-09-07 — the OpenAPI 3.1 spec (`openapi.json`) and the Postman handover collection (`aihub.postman_collection.json`) are both generated from source, not hand-written.
- Implemented: idempotency replay for completed successful attempts, the ErrorCode→httpStatus registry, and the public API docs page at `/docs` (with the raw spec at `/openapi.json`).
- Open, but not blocking: richer metering (`usage`/model on the public response) and six fixes requested from the AI Writing team (chiefly usage metadata, which is what makes token-based billing possible at all).

## Canonical documents

- [Contract](docs/aihub_deliverable_1_api_contract_schema.md)
- [Spec index](docs/superpowers/specs/2026-09-07-aihub/README.md)
- [Agent and architecture design](docs/superpowers/specs/2026-09-07-aihub/12-agent-workflow-and-clean-architecture-design.md)
- [Matt issue workflow](docs/agents/issue-tracker.md)
