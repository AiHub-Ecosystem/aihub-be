# ADR-0138: Batch AI-service breaking changes into Public API v2

- Status: Proposed — pending AIHUB and WISPACE approval, the Organization-ID mapping decision, and the evidence below.
- Date: 2026-10-31
- Related: [ADR-0127](0127-public-api-uri-major-versioning.md), [ADR-0131](0131-customers-are-told-when-grading-behavior-changes.md), [#72](https://github.com/AiHub-Ecosystem/aihub-be/issues/72), [#1374](https://github.com/AiHub-Ecosystem/aihub-be/issues/1374)

## Context

Issue #1374 is waiting for an approved breaking Public API change. The AI
Speaking v2.4 response cannot supply several required `/v1` values with their
current meaning, and deriving those values in AIHUB would invent feedback. AI
Writing v3 changes `Overall Assessment.Summary` from a string to an object and
adds structured progress, errors, and suggestions. Both changes need a new
AIHUB response contract.

ADR-0127 defines a major over the whole Public API, not one service. It requires
`/v1` to remain available alongside a complete `/v2` contract. AI Speaking
supplied v2.4 integration documentation and Production captures on 2026-10-31.
The captures cover all six provider operations through a two-question Part 1
flow, plus audio, authentication, header-validation, and not-found errors. The
provider reports v2.4 is deployed; there is no staging environment. The
sanitized responses are recorded in
`test/fixtures/ai-speaking/grading-v2-*.json`.

The confirmed provider header contract introduces an integration blocker:
Speaking requires `X-AIHUB-Organization-Id` to be a UUID, while AIHUB's
customer-facing Organization IDs use the opaque `org_...` format. AIHUB has no
approved mapping to the provider's UUID. Forwarding the AIHUB ID directly
would be rejected, and inventing a derived identifier without a durable,
approved mapping would break tenant ownership and deletion.

## Proposal

1. Batch the AI Writing and AI Speaking contract changes into one AIHUB `/v2`
   release. Do not add `/v2` to the released-major registry until its complete
   public contract, versioned OpenAPI document, migration notice, and route set
   are ready.
2. Keep AIHUB `/v1` on the provider v1 Writing endpoints and provider v1
   Speaking endpoints. The Writing v1 paths are now pinned explicitly in the
   operation catalog. Before release, confirm that both providers will keep
   their v1 endpoints available for the `/v1` support window in ADR-0127.
3. Route AIHUB `/v2` Writing grading to AI Writing `/v3/grading-feedback-task1`
   and `/v3/grading-feedback-task2`; route AIHUB `/v2` Speaking operations to
   the provider's `/api/v2/speaking` contract. AIHUB owns its public request and
   response schemas and maps only fields in the approved fixtures.
4. Never pass a provider response through unchanged. In particular, do not
   expose Writing `data.coT` or Speaking provider identity and internal
   diagnostic fields. Public identifiers for Speaking response, part, and test
   retrieval need an explicit ownership decision before implementation.
5. Derive organization, end-user ID, and identity mode from AIHUB's
   authenticated API key and resolved user identity. The provider has confirmed
   that v2.4 requires `X-AIHUB-Organization-Id`, `X-AIHUB-User-Id`, and
   `X-AIHUB-User-Identity-Mode`, and that its v1 endpoints accept those headers
   while retaining the v1 `user_id` request field. Resolve the UUID mapping
   before sending the organization header. Never accept provider identity
   headers directly from an AIHUB customer request.

## Alternatives

- **Upgrade the existing `/v1` responses in place:** rejected because current
  Speaking clients depend on fields whose type or meaning changes, and
  Writing v3 changes a response field's type.
- **Expose provider bodies directly:** rejected because that would make
  provider-only fields and identifiers part of AIHUB's customer contract.
- **Release one major per service:** rejected because ADR-0127 versions the
  whole Public API and would force customers through multiple migrations.
- **Pass AIHUB's `org_...` identifier as the provider UUID:** rejected because
  it violates the provider's validation contract and would silently lose the
  intended tenant partitioning on v1.

## Required evidence before acceptance and release

- AIHUB approves the exact `/v2` Writing and Speaking response schemas,
  including the ownership of Speaking retrieval identifiers.
- AI Writing supplies redacted v3 response fixtures for both tasks and
  confirms the provider v1 support period.
- WISPACE and AIHUB review and approve the Speaking v2.4 contract and sanitized
  captures recorded in
  [the Speaking provider contract](../contracts/ai-services/ai-speaking-grading-v2.4.md).
- Resolve a durable mapping between AIHUB Organization IDs and provider UUIDs,
  or obtain provider support for the existing opaque ID format. Verify both
  organization and user isolation before production integration.
- AIHUB serves the complete `/v2` route set and publishes the OpenAPI, customer
  changelog, and Integration Guide migration instructions required by
  ADR-0127.

## Consequences

This proposal does not change runtime behavior or publish `/v2`. The new
Production captures establish more provider behavior than the earlier
one-question probe, but they do not approve the AIHUB public contract, represent
a complete three-Part test, or include a captured `429` response. Until this
ADR is accepted and the UUID mapping and remaining evidence exist, the
released-major registry stays at `/v1`, and issue #1374 stays open. The AIHUB
`/v1` Writing path pin and sanitized Speaking captures are preparation only;
they do not establish customer contract approval or release readiness.
