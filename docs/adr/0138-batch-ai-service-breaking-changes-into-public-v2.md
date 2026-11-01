# ADR-0138: Batch AI-service breaking changes into Public API v2

- Status: Proposed; amended by [ADR-0143](0143-public-v2-serves-ai-writing-v3-grading.md) — design agreed by the AIHUB owner on 2026-11-01; `/v2` was released ahead of the evidence below, which is tracked in #1450.
- Date: 2026-10-31
- Writing's schema, routes, timeout and enablement gate: [ADR-0143](0143-public-v2-serves-ai-writing-v3-grading.md)
- Amended: 2026-11-01 — the first `/v2` carries Speaking only and ships with `/v1`'s ADR-0127 sunset; Writing v3 joins `/v2` later as an additive change (decisions 1, 2, 4, 6, 8 and 10)
- Related: [ADR-0127](0127-public-api-uri-major-versioning.md), [ADR-0131](0131-customers-are-told-when-grading-behavior-changes.md), [ADR-0140](0140-tenant-identity-is-the-organization-and-end-user-id-pair.md), [#72](https://github.com/AiHub-Ecosystem/aihub-be/issues/72), [#1374](https://github.com/AiHub-Ecosystem/aihub-be/issues/1374), [#70](https://github.com/AiHub-Ecosystem/aihub-be/issues/70)

## Context

Issue #1374 is waiting for an approved breaking Public API change. The AI
Speaking v2.4 response cannot supply several required `/v1` values with their
current meaning, and deriving those values in AIHUB would invent feedback. AI
Writing v3 changes `Overall Assessment.Summary` from a string to an object and
adds structured progress, errors, and suggestions.

ADR-0127 defines a major over the whole Public API, not one service. It requires
`/v1` to remain available alongside a complete `/v2` contract.

**Speaking.** The provider supplied v2.4 integration documentation and
Production captures on 2026-10-31: all six provider operations through a
two-question Part 1 flow, plus audio, authentication, header-validation, and
not-found errors. The sanitized responses are in
`test/fixtures/ai-speaking/grading-v2-*.json`. The provider reports v2.4 is
deployed and has no staging environment. It accepts AIHUB's opaque `org_...`
Organization IDs directly (commit `148f126`).

**Writing.** Real v3 responses for both tasks were captured on 2026-11-01 from the
provider's Test environment and are in
`test/fixtures/ai-writing/grade-v3-task{1,2}.*`. Against the v1 fixtures, v3
adds per-criterion `errors[]` and `suggestions[]`, `Overall Assessment.Progress`,
`usage` and `metrics`; changes `Summary` from a string to an object; replaces
the snake_case `data_micro` codes with standard ones (`LR03`, `TR05`); and drops
`Specific Suggestions` and `Next Steps`. Each task was captured once.

## Decision

1. **The first `/v2` carries Speaking only.** Launch gate
   [#416](https://github.com/AiHub-Ecosystem/aihub-be/issues/416) is open, and
   Speaking v1 is the contract the provider is replacing. `/v2` has six
   routes: `POST /v2/ielts/speaking/questions/grade`, `.../parts/grade`,
   `.../tests/grade` (named `/grade` by ADR-0129; the provider calls them
   `grading`), and `GET .../responses/{response_id}`,
   `.../parts/{part_result_id}`, `.../tests/{test_id}`. `grading-json` has no
   provider v2.4 counterpart (there is no `audio_url` operation) and stays on
   `/v1` until `/v1` retires.
2. **Writing is not served under `/v2` at launch.** Serving the v1 Writing shape
   under `/v2` would freeze it there, and adopting v3 would then need `/v3`.
   When the Writing v3 mapping is approved, its routes are added to `/v2` with
   the v3 shape, which is an additive change. Until then a customer calls
   Speaking on `/v2` and Writing on `/v1`. A route whose contract is
   identical in two majors may share one controller; `check:api-compatibility`
   catches drift. A route whose contract differs has its own controller.
3. **AIHUB owns the `/v2` response schema, derived from v2.4 only.** The
   response is the `data` object of the common `{ data, meta }` envelope. It
   carries `meta`, `scores`, `overall_feedback` and `criteria` (each criterion's
   `summary` and, on a question result, its located `diagnostics`), and a
   question result also carries the `transcript` with word timings. Hidden from
   customers: `meta.user_id`, `system`, `href` paths, `usage` and its cost
   (AIHUB meters on its own), `meta.codebook`, the ASR diagnostics, `gate`,
   `trajectory`, `error_summary`, `pronunciation_detail` and each criterion's
   `evidence`. Hiding is the default because adding a field later is not
   breaking and removing one is. A v1 value v2.4 cannot supply (`scorability`,
   `relevance`, `pause_count`, `duration_seconds`, `grammar_errors`,
   `vocabulary_upgrades`, `strong_point_vi`, `action_plan_vi`, the old
   pronunciation structure) is not rebuilt; the migration guide lists what is
   lost. `test_type` is `practice` | `full_test` in both directions; the adapter
   converts to the provider's request spelling (`Practice`, `Full-test`).
4. **AIHUB checks ownership of retrieval identifiers itself** (ADR-0140
   decision 5). A durable record `(Organization, End-User ID, kind, id)` is
   written when a POST succeeds: `response_id` comes from the provider,
   `part_result_id` and `test_id` from the customer, recorded on first use. It is
   checked before every GET and for every id in `response_ids` and
   `part_result_ids` before an aggregation POST. A miss answers `NOT_FOUND`
   without forwarding. The key includes the End-User because the provider lets
   two users reuse the same `part_result_id`. **The first release shipped
   without this check** (2026-11-01, at the owner's request); the provider's own
   scoping is the only barrier until [#1449](https://github.com/AiHub-Ecosystem/aihub-be/issues/1449)
   lands.
5. **Only POST is metered.** `questions/grade`, `parts/grade` and `tests/grade`
   are graded operations. The three GETs re-read stored results and never write
   usage.
6. **Provider errors map as follows.** Provider 404 (`not_found`,
   `part_not_found`, `response_not_found`) becomes `NOT_FOUND`, the same answer
   a miss in decision 4 will give. `audio_unreadable` becomes `AUDIO_UNREADABLE`.
   429 becomes `AI_SERVICE_THROTTLED` and now forwards the provider's
   `Retry-After` for `/v1` and `/v2` alike. 503 `storage_unavailable` becomes
   `AI_SERVICE_UNAVAILABLE` with its `Retry-After`. 502 and 504 keep
   `AI_SERVICE_ERROR` and `AI_SERVICE_TIMEOUT`. The provider's aggregation 422
   errors are not captured yet, so they stay in the `AI_SERVICE_ERROR` family;
   a dedicated public code waits for the captures and for the Customer Web
   contract to list it first ([#1450](https://github.com/AiHub-Ecosystem/aihub-be/issues/1450)).
7. **The three POSTs keep `idempotency: 'none'`,** as `/v1` Speaking does.
   Optional idempotency for a 25 MiB multipart body is a separate decision and
   can be added without breaking a client. The documentation states that a
   retry after a network failure of `questions/grade` can be charged twice.
8. **`/v1` receives the sunset ADR-0127 requires with the successor release.**
   The release gate refuses a superseded major without one. `/v1` carries
   `Deprecation` from 2026-11-01 and `Sunset` on 2027-11-02, the earliest date
   the 12-month rule allows. A sunset only moves later, by owner decision
   (#1376). Writing must reach `/v2` before the date or the owner extends it.
9. **Identity.** Organization, End-User ID and identity mode come from AIHUB's
   authenticated API key and resolved User Identity (ADR-0140). A customer
   request never supplies them. The Sandbox admission and budget path applies to
   `/v2` unchanged.
10. **The registry gains `/v2` with the complete route set.** The release adds
    major 2 to the registry together with its six routes, `openapi/v2.json`, the
    migration notice and the Integration Guide section. No placeholder `/v2`.
    The Postman collection is still built from the `/v1` document and does not
    yet carry `/v2` requests.

## Alternatives

- **Batch Writing v3 and Speaking v2.4 into the first `/v2`** (this ADR's
  original proposal): rejected on 2026-11-01. It adds a second provider
  commitment and a second schema approval to a release that is already
  gated on Speaking.
- **Serve Writing v1 under `/v2` at launch:** rejected. It freezes the v1
  shape into `/v2`, so adopting Writing v3 would need `/v3`.
- **Upgrade the existing `/v1` responses in place:** rejected because current
  Speaking clients depend on fields whose type or meaning changes.
- **Expose provider bodies directly:** rejected because provider-only fields
  and identifiers would become AIHUB's customer contract.
- **Release one major per service:** rejected because ADR-0127 versions the
  whole Public API and would force customers through several migrations.
- **Rely on the provider's 404 for retrieval ownership:** rejected by ADR-0140
  decision 5; AIHUB cannot prove the provider's partitioning from outside.
- **Invent provider UUIDs from AIHUB IDs:** rejected because the provider
  accepts the opaque ID directly.

## Required evidence before acceptance and release

- WISPACE and AIHUB approve the Speaking `/v2` response schema and the
  Speaking v2.4 contract recorded in
  [the Speaking provider contract](../contracts/ai-services/ai-speaking-grading-v2.4.md).
- The provider confirms in writing: its v1 support period (Speaking, and Writing
  before Writing joins `/v2`), the request spelling of `test_type`
  (`full_test` against `Full-test`), the list of aggregation error codes, and
  how long stored results are kept.
- A complete three-Part exam (Part 1, 2, 3, then Part and Test aggregation) is
  captured as fixtures from the Test environment.
- Cross-Organization and cross-User isolation for the opaque IDs is verified
  under #70.
- AIHUB serves the complete `/v2` route set and publishes the OpenAPI document,
  customer changelog and Integration Guide migration instructions required by
  ADR-0127.

Before Writing joins `/v2`, AIHUB also approves the Writing v3 response schema
(including what happens to `data.coT`) against the captured v3 fixtures.

## Consequences

This release brought `/v2` forward of the evidence above, at the owner's
request. Until that evidence exists this ADR stays Proposed and #1374 stays
open. What is deferred is tracked: the ownership check in #1449, the provider
confirmations, captures and approvals in #1450. The Writing v3 fixtures and the
`/v1` Writing path pin are preparation for Writing joining `/v2`, not customer
approval.
