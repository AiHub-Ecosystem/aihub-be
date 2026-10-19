# ADR-0112: Public API stays OpenAPI/REST; tRPC considered and declined

- Status: Proposed — drafted before its owning record existed; the decision is confirmed in [#824](https://github.com/AiHub-Ecosystem/aihub-be/issues/824). Flip to Accepted only after the owner approves there and the PR merging this file references #824.
- Date: 2026-10-19
- Related: [ADR-0015](0015-ai-speaking-json-url-boundary.md), [ADR-0040](0040-organization-audit-read-boundary.md), [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md), [ADR-0095](0095-demo-environments-and-sandbox-allowance-policy.md), [long-term architecture](../aihub_long_term_architecture.md), [#290](https://github.com/AiHub-Ecosystem/aihub-be/issues/290), [#461](https://github.com/AiHub-Ecosystem/aihub-be/issues/461), [#473](https://github.com/AiHub-Ecosystem/aihub-be/issues/473), [#824](https://github.com/AiHub-Ecosystem/aihub-be/issues/824), [AiHub-Frontend #99](https://github.com/AiHub-Ecosystem/AiHub-Frontend/issues/99)

AIHUB keeps the public API and the Customer Web BFF boundary on TypeBox contracts generated into OpenAPI 3.1 and Postman, served at `/openapi.json` and `/docs`. tRPC was evaluated as a way for `AiHub-Frontend` (Next.js/TypeScript) to share types with this backend and is declined. This records the non-decision so it is not re-litigated.

## Context

The active contract is code: `src/contracts/` TypeBox schemas are the single source, and the OpenAPI/Postman artifacts are generated from the operation catalog ([ADR-0015](0015-ai-speaking-json-url-boundary.md), [ADR-0040](0040-organization-audit-read-boundary.md)). The API is a B2B, server-to-server surface whose consumers may be written in any language, and the Customer Web reaches the same `/v1` routes that external callers use (see `docs/customer-web-identity-onboarding.md`). Cross-repo type drift is already guarded: [#473](https://github.com/AiHub-Ecosystem/aihub-be/issues/473) fails a PR that breaks a customer integration, [#461](https://github.com/AiHub-Ecosystem/aihub-be/issues/461) fails a change to a response the BFF reads before either repo deploys, and [#290](https://github.com/AiHub-Ecosystem/aihub-be/issues/290) versions the public contract with a customer-facing changelog.

tRPC's own documentation (v11.x) confirms two properties that collide with this design: its clients run only where JavaScript/TypeScript runs (there is no PHP/Java/Python client), and its stated value is "no schemas, no code generation" — the opposite of the machine-readable, language-neutral artifact AIHUB must publish to customers as the product.

## Decision

Do not adopt tRPC for the public API or the BFF seam. Keep the TypeBox to OpenAPI pipeline as the single source of truth.

Alternatives evaluated and declined:

- **tRPC native.** It drops the OpenAPI/Postman/multi-language contract and forks a parallel router surface over the same operations, duplicating guards, metering, and the public-route registry ([ADR-0059](0059-non-dispatch-public-api-routes-have-their-own-registry.md)). It would move validation from TypeBox to Zod, and it wants client and server to deploy in lockstep, which conflicts with the deliberate independence of `AiHub-Frontend` and `aihub-be` that [#461](https://github.com/AiHub-Ecosystem/aihub-be/issues/461) and [#290](https://github.com/AiHub-Ecosystem/aihub-be/issues/290) enforce.
- **tRPC plus `@trpc/openapi`.** That package is alpha and exists only to re-derive an OpenAPI document, reintroducing the schema/codegen step tRPC advertises removing, while AIHUB already produces that artifact from the operation catalog with `validate:openapi` gating it in CI. A reported Fastify incompatibility with `@fastify/compress` also intersects the open compression evaluation at [#804](https://github.com/AiHub-Ecosystem/aihub-be/issues/804).

## Consequences

- No runtime or contract change; this is a documentation decision only.
- The genuine "share types in the frontend" need is served without tRPC: `AiHub-Frontend` generates TypeScript client types from AIHUB's `/openapi.json`, replacing the hand-maintained API-Reference catalog that `docs/integration-guide-ui-brief.md` flags as drift-prone. Tracked as [AiHub-Frontend #99](https://github.com/AiHub-Ecosystem/AiHub-Frontend/issues/99).
- Revisit only if AIHUB ever ships a first-party, same-deploy TypeScript client as the primary consumer and still keeps the OpenAPI artifact for third parties. Today the open, language-neutral contract — not a shared TypeScript type — is the product.

## Confirmation

Pending. The AIHUB owner records the decision on [#824](https://github.com/AiHub-Ecosystem/aihub-be/issues/824); on approval, set `Status: Accepted` with the approver and date here, and merge this file through a PR that references #824. The frontend substitute — AiHub-Frontend#99, TypeScript types generated from AIHUB `/openapi.json` — stands independently of this decision.
