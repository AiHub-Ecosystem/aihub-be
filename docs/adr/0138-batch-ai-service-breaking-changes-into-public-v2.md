# ADR-0138: Batch AI-service breaking changes into Public API v2

- Status: Proposed — pending AIHUB owner approval and the provider agreements below.
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
`/v1` to remain available alongside a complete `/v2` contract. The current
Speaking captures cover one synthetic question and one validation error only;
they are candidate fixtures, not an approved baseline. The repository also has
no captured AI Writing v3 fixtures yet.

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
5. Derive organization and end-user identity from AIHUB authentication. Before
   production integration, AI Speaking must confirm tenant partitioning via
   the agreed `X-AIHUB-Organization-Id`, `X-AIHUB-User-Id`, and
   `X-AIHUB-User-Identity-Mode` headers, with no caller-controlled `user_id` in
   provider body or query. This is a release requirement, not evidence that the
   provider has accepted or deployed the headers.

## Alternatives

- **Upgrade the existing `/v1` responses in place:** rejected because current
  Speaking clients depend on fields whose type or meaning changes, and
  Writing v3 changes a response field's type.
- **Expose provider bodies directly:** rejected because that would make
  provider-only fields and identifiers part of AIHUB's customer contract.
- **Release one major per service:** rejected because ADR-0127 versions the
  whole Public API and would force customers through multiple migrations.

## Required evidence before acceptance and release

- AIHUB approves the exact `/v2` Writing and Speaking response schemas,
  including the ownership of Speaking retrieval identifiers.
- AI Writing supplies redacted v3 response fixtures for both tasks and
  confirms the provider v1 support period.
- AI Speaking owner and WISPACE approve the v2.4 contract and candidate
  fixtures under section 8 of
  [the Speaking provider contract](../contracts/ai-services/ai-speaking-grading-v1.md).
- AI Speaking verifies tenant isolation for header-only identity and supplies
  evidence for multi-question aggregation and representative error responses.
- AIHUB serves the complete `/v2` route set and publishes the OpenAPI, customer
  changelog, and Integration Guide migration instructions required by
  ADR-0127.

## Consequences

This proposal does not change runtime behavior or publish `/v2`. Until it is
accepted and the evidence above exists, the released-major registry stays at
`/v1`, and issue #1374 stays open. The AIHUB-side `/v1` Writing path pin and
candidate Speaking fixtures are preparation only; they do not establish
provider compatibility, customer contract approval, or production readiness.
