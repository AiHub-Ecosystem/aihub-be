# ADR-0127: Public API major versions use URI paths

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-26 in [#1295](https://github.com/AiHub-Ecosystem/aihub-be/issues/1295).
- Date: 2026-10-26
- Related: [ADR-0112](0112-public-api-stays-openapi-trpc-declined.md), [#290](https://github.com/AiHub-Ecosystem/aihub-be/issues/290), [#461](https://github.com/AiHub-Ecosystem/aihub-be/issues/461), [#473](https://github.com/AiHub-Ecosystem/aihub-be/issues/473), [#610](https://github.com/AiHub-Ecosystem/aihub-be/issues/610), [#1259](https://github.com/AiHub-Ecosystem/aihub-be/issues/1259), [#1295](https://github.com/AiHub-Ecosystem/aihub-be/issues/1295)

## Context

AIHUB's customer API is REST and publishes an OpenAPI contract generated from source, as recorded in ADR-0112. Production currently serves the whole Public API under `/v1`. The Integration Guide promises that clients tolerate unknown response fields, while the generated response object schemas mark `additionalProperties: false`; schema-driven clients can therefore reject a response that the compatibility promise allows. Request bodies also use closed schemas, intentionally rejecting unknown fields.

Issue #290 tracks a public contract version and customer-facing changelog. Issue #1259 explores date-header Schema Lenses as an alternative version selector. AIHUB needs one major-version policy that keeps existing `/v1` customers working through incompatible contract changes and aligns the published schema with the customer promise.

## Decision

- The Public API Major Version covers the whole Public API Contract, including dispatch and non-dispatch Public API Routes. Operational health probes are outside that contract. The URI path is the only public major-version selector: `/v1`, `/v2`, and later major paths. A client may use supported majors per request during the transition window.
- Keep `/v1` as the current contract. Compatible additions stay in the current major. Introduce the next major only for a concrete breaking contract change; do not publish an identical `/v2` surface just to advance the number. A breaking change includes removing or renaming an existing route or field, changing an existing field's type or meaning, narrowing accepted request values, making a request field required, removing a response enum value, or adding a value to a closed response enum.
- Use SemVer for the Public API Contract Version in OpenAPI `info.version`, independently of the backend package version. Establish the current `/v1` contract baseline as `1.0.0`; compatible contract additions increment the minor version, and documentation-only contract changes increment the patch version. A new URI major starts at its matching SemVer major, so `/v2` starts at `2.0.0`.
- Publish an immutable OpenAPI document per supported major at `/openapi/vN.json`. Keep `/openapi.json` as an alias to the newest major and provide a version selector in `/docs`. `CHANGELOG.md` is the canonical customer-facing changelog and the Integration Guide links to it.
- Public response object schemas are extensible, including nested envelope, `data`, `meta`, and resource objects. The published OpenAPI contract must allow additional response properties so schema-driven clients can follow the promise to ignore fields they do not recognize. Request body schemas remain closed. New optional request fields are compatible when existing callers can omit them; AIHUB documents them for customer use only after both the deployed release and its normal rollback target accept them.
- The normal rollback target is the immediately preceding successful release. A rollback to an older image requires a reviewed, migration-specific plan that prevents clients from sending fields the target does not support. An intentional-break declaration alone does not permit a breaking change to remain in a supported major; the change belongs in the next major while the prior supported contract remains available.
- When a successor major is released, keep the preceding major available for at least 12 months and publish its sunset date with the successor release. Before sunset, review customer traffic and contact affected customers. If customers are still migrating, an explicit owner decision may extend support; publish the revised date. After sunset, requests to the retired major return `410 Gone` with the standard error envelope and successor information.
- Use the URI path, not a date-version header, to select a public API major. The general Schema Lenses pipeline in #1259 is not adopted for public API versioning; reconsider it only if a concrete contract migration needs that transformation.
- The compatibility gate allows additive response properties on extensible response objects and compatible optional request additions. It still blocks breaking changes within a supported major, including field removals or type changes and additions to closed response enums. A new major requires its versioned OpenAPI contract, changelog entry, and migration notice while preserving the prior supported contract.

## Consequences

Customers can keep using `/v1` while adopting a successor major at their own pace. No `/v2` runtime route is introduced by this decision; the first `/v2` migration is tied to a specific breaking contract change. The OpenAPI response schemas and compatibility gate need implementation work to match this policy; issues #1296 and #1297 track the release artifacts and CI enforcement. The rollback runbook must follow the normal-target rule before customers are told to send a newly added optional request field.

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-10-26 in #1295. This decision selects the public API compatibility policy; it does not by itself implement or deploy `/v2`.
