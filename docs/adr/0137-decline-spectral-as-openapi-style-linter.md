# ADR-0137: Decline Spectral as an OpenAPI style linter; enforce conventions in source specs

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-31 in [#1421](https://github.com/AiHub-Ecosystem/aihub-be/issues/1421).
- Date: 2026-10-31
- Related: [ADR-0112](0112-public-api-stays-openapi-trpc-declined.md), [ADR-0127](0127-public-api-uri-major-versioning.md), [ADR-0129](0129-public-route-and-response-convention.md), [#473](https://github.com/AiHub-Ecosystem/aihub-be/issues/473), [#1421](https://github.com/AiHub-Ecosystem/aihub-be/issues/1421)

## Context

AIHUB publishes versioned OpenAPI 3.1 contracts (`openapi/v1.json` and `openapi.json`) for B2B integrators. Today, `scripts/checks/validate-openapi.mjs` runs `@seriousme/openapi-schema-validator` in CI and `pnpm verify` to confirm structural schema validity and ensure alias synchronization. Breaking contract changes are separately checked across releases with `oasdiff` in `scripts/ci/api-compatibility/` ([#473](https://github.com/AiHub-Ecosystem/aihub-be/issues/473), [ADR-0127](0127-public-api-uri-major-versioning.md)).

Issue [#1421](https://github.com/AiHub-Ecosystem/aihub-be/issues/1421) asked for an evaluation of Spectral (Apache-2.0, CLI linter) to assess whether to adopt it as an OpenAPI style and convention linter, or to decline it in favor of existing TypeScript and Jest verification.

In AIHUB, OpenAPI documents are compiled artifacts rather than hand-authored source files. They are generated deterministically by `scripts/generate/generate-openapi.ts` from `src/catalog/public-routes.ts`, `src/catalog/operation-catalog.ts`, and `src/contracts/`.

## Spike results

Spectral CLI 6.17.0 was evaluated against `openapi/v1.json` using its built-in OpenAPI ruleset (`spectral:oas`, 57 rules).

51 out of 57 rules passed cleanly on `openapi/v1.json`, including operationId uniqueness, operation parameter uniqueness, presence of success responses, absence of trailing slashes or query parameters in paths, valid server definitions, and resolved security schemes.

The remaining 6 rules produced 94 findings:

1. **`info-contact` (1 warning)**: Optional per OpenAPI 3.1 §4.8.2. Classified as noise; integration support is maintained in `docs/integration-guide.md`.
2. **`info-description` (1 warning)**: Optional per OpenAPI 3.1 §4.8.2. Classified as noise; high-level service documentation is documented in markdown guides and ADRs.
3. **`operation-description` (20 warnings)**: Optional per OpenAPI 3.1 §4.8.10. Classified as noise; every operation already requires a `summary` enforced at compile time by `OpenApiOperationMetadata`.
4. **`operation-tags` (60 warnings)**: Optional per OpenAPI 3.1 §4.8.10. Classified as noise; AIHUB structures routes by URI prefix hierarchy (`/v1/ielts/…`, `/v1/organizations/…`) and operation IDs ([ADR-0129](0129-public-route-and-response-convention.md)), rather than flat OpenAPI tags.
5. **`oas3-schema` (4 errors)**: Enforced / known tooling constraint. Flags `items: […]` tuple syntax in `AudioExtentSchema` (`src/contracts/speaking/grading.ts`). While OpenAPI 3.1 / JSON Schema 2020-12 uses `prefixItems`, TypeBox generates Draft-7 tuple definitions, which are intentionally retained for compatibility with `oasdiff` (documented in `scripts/ci/api-compatibility/check.mjs:normalizeLegacyTuples`). `@seriousme/openapi-schema-validator` accepts this schema.
6. **`path-params` (8 errors)**: Real convention gap. In `src/catalog/public-routes.ts`, four upload routes declare path template `:assetId` which `toOpenApiPath()` renders as `{asset_id}`, but their parameter metadata specifies `name: 'assetId'` in camelCase rather than snake_case:
   - `POST /v1/speaking/audio/uploads/:assetId/refresh`
   - `POST /v1/speaking/audio/uploads/:assetId/complete`
   - `POST /v1/ielts/writing/task1/chart-uploads/:assetId/refresh`
   - `POST /v1/ielts/writing/task1/chart-uploads/:assetId/complete`
     In contrast, `POST /v1/me/avatar/uploads/:assetId/complete` correctly declared `name: 'asset_id'`. OpenAPI 3.1 §4.8.12 requires template parameter names to match path parameter declarations case-sensitively.

### Minimal ruleset evaluation

- A minimal ruleset isolating `path-params` failed with 8 errors against the current mismatched document, and passed with 0 errors on a document with matching `{asset_id}` parameter declarations.
- A minimal ruleset for accepted core conventions (`operation-operationId`, `operation-success-response`, `path-keys-no-trailing-slash`, `path-not-include-query`) passed with 0 errors on `main`, and failed immediately when an operationId or success response was removed from a test document.

## Decision

Decline adopting Spectral as an OpenAPI style linter.

1. **Architecture fit**: OpenAPI documents are generated from code, not hand-edited. Enforcing style rules on the generated JSON output is the wrong abstraction level when conventions are already enforced at source via TypeScript types and Jest suites (`src/catalog/public-route-convention.spec.ts`, `src/openapi/openapi-route-coverage.spec.ts`, `src/openapi/openapi-response-schema-policy.spec.ts`, `src/openapi/openapi-success-statuses.spec.ts`, and `src/openapi/build-openapi-document.spec.ts`).
2. **Supply-chain and performance cost**: `@stoplight/spectral-cli` adds over 100 transitive dependencies, deprecated upstream packages, complex ESM/CJS bundling constraints, and 8–10 seconds of execution overhead per run.
3. **Spec-first enforcement**: The single real gap surfaced by the spike (`path-params`) is cleanly and deterministically prevented by an in-tree Jest assertion in `src/openapi/build-openapi-document.spec.ts` in ~15 lines with 0ms incremental overhead and zero new dependencies.

## Consequences

- No new dependencies (`@stoplight/spectral-cli` or ruleset packages) are added to `package.json`.
- `scripts/checks/validate-openapi.mjs` remains focused on OpenAPI 3.1 structural schema validation.
- The parameter naming inconsistency on the 4 upload routes (`assetId` vs `asset_id`) is fixed directly in `src/catalog/public-routes.ts`, and enforced permanently by a Jest path-parameter template matching rule in `src/openapi/build-openapi-document.spec.ts`.

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-10-31 and recorded on [#1421](https://github.com/AiHub-Ecosystem/aihub-be/issues/1421).
