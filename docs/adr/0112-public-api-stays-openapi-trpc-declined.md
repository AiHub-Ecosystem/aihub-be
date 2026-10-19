# ADR-0112: Public API stays OpenAPI/REST; BFF tRPC evaluation is separate

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-19 in [#824](https://github.com/AiHub-Ecosystem/aihub-be/issues/824). The separate Customer Web BFF evaluation does not gate this public API decision.
- Date: 2026-10-19
- Related: [ADR-0015](0015-ai-speaking-json-url-boundary.md), [ADR-0040](0040-organization-audit-read-boundary.md), [ADR-0059](0059-non-dispatch-public-api-routes-have-their-own-registry.md), [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md), [#290](https://github.com/AiHub-Ecosystem/aihub-be/issues/290), [#461](https://github.com/AiHub-Ecosystem/aihub-be/issues/461), [#473](https://github.com/AiHub-Ecosystem/aihub-be/issues/473), [#824](https://github.com/AiHub-Ecosystem/aihub-be/issues/824), [AiHub-Frontend #99](https://github.com/AiHub-Ecosystem/AiHub-Frontend/issues/99), [AiHub-Frontend #100](https://github.com/AiHub-Ecosystem/AiHub-Frontend/issues/100)

## Context

AIHUB's public grading API uses TypeBox schemas as the source for its REST contract, OpenAPI 3.1 document, and Postman artifacts. External B2B consumers need a language-neutral public contract.

The Customer Web browser calls a backend-for-frontend (BFF) owned by AiHub-Frontend; that BFF calls AIHUB's `/v1` API. A decision about the browser-to-BFF seam does not change the contract AIHUB publishes to external consumers.

The proposed cross-repository checks and public-contract versioning tracked by AIHUB #290, #461, and #473 remain open. They are planned work, not implemented guardrails. AiHub-Frontend #99, which proposes generating TypeScript types from `/openapi.json`, is also open; that code generation is not yet implemented.

## Decision

Keep the public AIHUB grading API as REST. TypeBox remains the schema source, with OpenAPI 3.1 and Postman as the published contract artifacts. This ADR does not select tRPC for public AIHUB routes.

This ADR makes no decision about tRPC between the Customer Web browser and its BFF. AiHub-Frontend #100 evaluates that seam separately using a mocked AIHUB upstream. The spike does not authorize adoption, production caller changes, deployment, or route migration; any adoption needs a separate decision and implementation issue or PR owned by the Frontend maintainer.

## Consequences

The public API and its OpenAPI/Postman artifacts remain unchanged. A successful BFF spike would not replace the public contract or by itself authorize production use of tRPC. The open cross-repository guardrail and code-generation issues remain plans until implemented and verified.

Revisit this decision if the public API's consumer or contract requirements change.

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-10-19 and recorded on [#824](https://github.com/AiHub-Ecosystem/aihub-be/issues/824). This acceptance covers only the public AIHUB API contract. The separate BFF evaluation in [AiHub-Frontend #100](https://github.com/AiHub-Ecosystem/AiHub-Frontend/issues/100) does not authorize tRPC adoption and does not need to finish before this ADR is merged through a PR referencing #824.
