# AIHUB Context

This is the short working index for agents. The full contract and architecture remain in the linked canonical documents.

## Purpose

AIHUB is a B2B multi-tenant AI API Gateway and identity broker. A client authenticates to AIHUB, AIHUB enforces organization policy and metering, then dispatches a typed operation to a private AI service. The first MVP slice is Writing question generation and grading.

## Vocabulary

- **Organization:** the tenant that owns API keys, identity configuration, quotas, usage, and downstream policy.
- **API key:** an organization credential presented with `X-API-Key`; AIHUB stores only its SHA-256 hash and metadata.
- **User Assertion:** a short-lived organization-signed assertion in `X-User-Assertion` for user-scoped operations.
- **Internal JWT:** a short-lived AIHUB-signed token used only on AIHUB-to-service calls.
- **Operation Catalog:** the typed code-owned mapping of public path, scope, identity mode, limits, timeout, and downstream operation.
- **Downstream Adapter:** a pure mapper between a public operation and a private AI service contract; it never performs network I/O.

## Ownership and invariants

- AIHUB owns the control plane: organization identity, API keys, scopes, metering, quota, idempotency, and routing policy.
- Each AI service owns its business data and model-specific behavior.
- `organizationId` is explicit in request context and application ports.
- Controllers are thin; application ports hide infrastructure; domain code is framework-free.
- Redis is ephemeral protection/cache state, never durable source of truth.
- Secrets, assertions, internal tokens, essays, and raw downstream bodies never enter logs.

## Current scope and blockers

- Current scope: one NestJS/Fastify app and the Writing vertical slice.
- Implemented: all four Writing operations (`task1/questions`, `task2/questions`, `task1/grade`, `task2/grade`) validate the public request, authenticate API keys against Postgres, use Redis for credential caching and rate limiting, dispatch through the typed Writing adapters, and return the `{ data, meta }` envelope. Local Postgres/Redis E2E verification passed on 2026-09-07.
- Deferred: Speaking, Reading, object storage, async jobs, billing, dynamic routing, Kubernetes, and a dedicated proxy.
- No blockers. Both earlier ones were resolved on 2026-09-07.
- Resolved: the Writing grading response contract. All four priority endpoints were called against the live service; captured responses are committed under `test/fixtures/ai-writing/` and the shared grading parser is implemented and tested. Catalog response contracts are real schemas, not `unresolved`.
- Resolved as a decision, not as work: AI Writing stays reachable from the internet for now, because it still serves an application that does not go through AIHUB. The boundary at this stage is the credential, not the network — AIHUB customers hold only AIHUB keys, so metering and limits still bind them. Three conditions keep that acceptable; see the security spec.
- Resolved: Deliverable 1 is frozen as of 2026-09-07 — the OpenAPI 3.1 spec (`openapi.json`) and the Postman handover collection (`aihub.postman_collection.json`) are both generated from source, not hand-written.
- Open, but not blocking: metering (usage/model on the public response), idempotency replay, the ErrorCode→httpStatus registry, an API docs page, and six fixes requested from the AI Writing team (chiefly usage metadata, which is what makes token-based billing possible at all).

## Canonical documents

- [Contract](docs/aihub_deliverable_1_api_contract_schema.md)
- [Spec index](docs/superpowers/specs/2026-09-07-aihub/README.md)
- [Agent and architecture design](docs/superpowers/specs/2026-09-07-aihub/12-agent-workflow-and-clean-architecture-design.md)
- [Matt issue workflow](docs/agents/issue-tracker.md)
