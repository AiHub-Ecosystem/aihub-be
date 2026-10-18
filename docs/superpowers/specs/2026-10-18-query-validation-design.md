# Strict query validation design

## Context

Issue [#576](https://github.com/AiHub-Ecosystem/aihub-be/issues/576) asks the API boundary to reject undeclared query parameter names consistently. `parseOrganizationAuditQuery` currently has a local allowlist and rejects unknown names; the Speaking questions controller reads only `part` and ignores others. The Organization membership list also validates its closed `status` schema with a local TypeBox check. The audit implementation therefore has the desired rejection but duplicates a rule that Speaking does not enforce, while membership bypasses the shared boundary helper.

ADR-0040, section 21, records hand-written query parsing as the intended approach because query parameters are string-valued and repeated keys have variable cardinality. Issue #576 intentionally changes that decision by requiring a shared boundary helper; the existing value-specific audit parsing and repeated-key behavior remain necessary.

## Options considered

1. **TypeBox schema-backed shared helper (recommended).** The helper accepts a closed object schema and raw query object, validates with TypeBox, returns its decoded/static type, and raises the uniform `INVALID_REQUEST`. Schemas declare permitted names and raw value rules, including the audit `action` string-or-array shape. This reuses the repository's boundary schema mechanism while leaving audit-specific date, pagination, and cursor semantics in its existing parser.
2. **Allowed-name list plus validator callbacks.** This can express the same values but invents a second schema language and makes contracts less visible alongside existing TypeBox schemas.
3. **Per-route Nest query pipes.** This could validate route inputs, but duplicates the common rule and makes the architecture check and empty-query contract less direct.

## Design

Add `parseRequestQuery` beside `parseRequestBody` under `src/common/http`. It validates a TypeBox object schema against the raw query object and returns the schema's typed value. A closed empty object schema is the explicit way for a route to allow no query parameters. Invalid shapes, undeclared names, and invalid values produce the same fixed `INVALID_REQUEST` response without echoing parameter names.

The audit route will pass its query through a closed schema before its existing parser performs semantic conversions and cursor checks. The route continues to accept repeated `action` values as an array and rejects repeated occurrences of single-valued parameters. The Speaking route will use its existing `SpeakingQuestionsQuerySchema` through the helper, replacing `@Query('part')`; its current valid `part` values and response mapping remain unchanged. The Organization membership list will use its existing closed `status` schema through the helper as well, preserving its filter and authentication behavior. Existing token-bearing routes that reject query parameters remain untouched.

The architecture check will reject controller access through `request.query` or `@Query(` unless that access is made in a `parseRequestQuery` call or carries the existing per-line `arch-check: <reason>` escape.

## Verification seams

- Helper unit tests cover valid decoded values, uniform errors, unknown names, and an empty schema that rejects every parameter.
- The audit and Speaking HTTP flow specs cover unknown and misspelled names, valid filters, repeated `action`, and refusal of repeated single-valued parameters. The Organization membership HTTP spec confirms its existing closed `status` schema refuses an undeclared name after helper adoption.
- The architecture-check spec creates an offending controller fixture and proves the check rejects unvalidated query access while honoring the escape marker.
- Run focused Jest specs, `pnpm type-check`, `pnpm arch-check`, and `pnpm verify`.

## Scope

No behavior change to authentication, token-bearing routes, audit filtering semantics, or Speaking response shape. No query names or rejected values are exposed in errors. No push or deployment is included.
