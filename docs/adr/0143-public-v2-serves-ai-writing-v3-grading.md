# ADR-0143: Public API v2 serves AI Writing v3 grading

- Status: Proposed — design agreed by the AIHUB owner on 2026-11-01; accepted when the provider evidence in [#1457](https://github.com/AiHub-Ecosystem/aihub-be/issues/1457) and [#1456](https://github.com/AiHub-Ecosystem/aihub-be/issues/1456) is recorded.
- Date: 2026-11-01
- Amends: [ADR-0138](0138-batch-ai-service-breaking-changes-into-public-v2.md) decision 2 (when and how Writing joins `/v2`)
- Related: [ADR-0085](0085-per-tier-blue-green-cutover.md), [ADR-0127](0127-public-api-uri-major-versioning.md), [ADR-0129](0129-public-route-and-response-convention.md), [ADR-0140](0140-tenant-identity-is-the-organization-and-end-user-id-pair.md), [#1452](https://github.com/AiHub-Ecosystem/aihub-be/issues/1452), [#1454](https://github.com/AiHub-Ecosystem/aihub-be/issues/1454), [#1455](https://github.com/AiHub-Ecosystem/aihub-be/issues/1455), [#70](https://github.com/AiHub-Ecosystem/aihub-be/issues/70)

## Context

ADR-0138 decision 2 left Writing out of the first `/v2` and promised that Writing would join later with the provider's v3 shape, as an additive change, once AIHUB approved the response schema. Real v3 captures for Task 1 and Task 2 exist in `test/fixtures/ai-writing/grade-v3-task{1,2}.*`.

Against `/v1`, v3 changes `Overall Assessment.Summary` from a string to an object, adds `Progress`, per-criterion `errors[]` and `suggestions[]`, `usage` (token counts and cost in USD), `metrics` and a chain-of-thought field `coT`, and reports errors with 48 standard codes in `data_micro`. The provider's own keys are mixed: `Overall Assessment`, `Summary`, `1_task_achievement`, `band_score`, `coT`.

The repository holds no provider document for v3 (path, authentication, headers) and none for the micro-exercise operations, which take `data_micro` as input and are tracked in #1454.

## Decision

1. **AIHUB owns the `/v2` Writing response schema.** An adapter maps the provider body to snake_case keys (`overall_assessment`, `summary.overall`, `summary.detail`, `summary.cta`, one `criteria` entry per criterion). The mapping is derived only from the captured v3 fixtures. String values pass through verbatim, including their leading `- `; AIHUB does not rewrite feedback.
2. **Hidden from customers:** `usage`, `metrics` and `coT`. AIHUB meters on its own, `usage` carries cost, and `coT` is the model's internal reasoning. **Published:** `overall_assessment.progress`. Hiding is the default because adding a field later is not breaking and removing one is.
3. **`data_micro` is returned inside `data`** as an open object keyed by trait and then by code. The 48 codes are opaque strings: the schema has no `enum` and no `pattern`, so a provider rename is not a breaking change. The Integration Guide lists the catalogue as informational and tells clients to tolerate unknown codes. A customer sends `data_micro` back verbatim to the micro-exercise operations; AIHUB does not store it.
4. **Routes:** `POST /v2/ielts/writing/task1/grade` and `POST /v2/ielts/writing/task2/grade`. Each has its own controller because its contract differs from `/v1` (ADR-0138 decision 2). Task 1 keeps using the `/v1` chart-upload routes, as `/v2` Speaking uses the `/v1` audio-upload routes.
5. **Operation settings match `/v1`:** scope `writing.grade`, `identityScope: 'user'`, `meteringMode: 'model'`, `idempotency: 'required'` and a 256 KiB body limit. `timeoutMs` is `125_000`, which covers the provider's 120-second `504`, so AIHUB can answer it as `AI_SERVICE_TIMEOUT`.
6. **Identity.** The three `X-AIHUB-*` headers of ADR-0140 decision 2 are sent on the v3 calls of `/v2` only, because v3 stores graded essays and weakness history. `/v1` Writing is unchanged.
7. **nginx.** `ops/nginx/aihub-api.conf` and `ops/nginx/sandbox.conf` set `proxy_read_timeout` and `proxy_send_timeout` to 75 seconds for the whole server, which would cut a 125-second call and return an nginx `504` instead of AIHUB's envelope. Each of the two routes gets its own `location =` block with 135 seconds (the operation timeout plus the same 10-second margin the 60-second routes keep). Other routes stay at 75.
8. **Shutdown budget.** ADR-0085 sizes the drain for a 60-second grading timeout. A 125-second timeout needs `stop_grace_period` of at least 280 seconds (125 seconds of HTTP drain, 140 seconds for background work, 5 seconds of telemetry, 10 seconds of margin). ADR-0085 is amended accordingly and #1455 carries the change.
9. **Micro-exercise operations are not decided here.** They get their own scope `writing.exercise` and metering, and a separate decision once captures exist (#1454).
10. **Enablement gate.** Amended 2026-11-01: the owner closed #70 and no longer holds Writing back for the provider's isolation evidence. The routes are added to the customer-visible `/v2` registry once #1455 is done and #1457 confirms that the provider accepts AIHUB's `org_...` Organization IDs and which authentication it requires, because without those the routes would answer `400` or `401`. The isolation evidence is tracked in #1456. The owner accepts the risk of serving `/v2` Writing before it arrives: v3 stores graded essays and weakness history, and `Progress` exposes each learner's history. Until the evidence is recorded the Integration Guide does not state that Writing data is isolated by `(Organization, End-User)`.

## Alternatives

- **Pass the provider keys through unchanged:** rejected. `Overall Assessment` and `1_task_achievement` would become `/v2` contract, and renaming them later is breaking. `/v2` is the one cheap point to rename.
- **Publish `usage` or `metrics`:** rejected. `usage` carries cost in USD, which `/v2` Speaking also hides.
- **Publish the 48 codes as a response `enum`:** rejected. A provider rename or addition would become a breaking change for every client that validates against the enum.
- **Cut the Writing timeout to 60 seconds to keep ADR-0085 unchanged:** rejected. v3 takes 30 to 45 seconds typically and up to 120 seconds, so 60 seconds would fail valid essays.
- **Re-serve the chart-upload routes under `/v2`:** rejected. `/v2` Speaking already shares the `/v1` upload routes, and nothing in the upload contract changes.
- **Ship Writing to `/v2` before the isolation evidence, like Speaking:** rejected, for the reasons in decision 10.

## Required evidence before acceptance

- The AI Writing team states in writing: the v3 request path, authentication and header contract (recorded as a provider contract document under `docs/contracts/ai-services/`); whether v3 grading partitions stored essays and history by `(Organization, End-User)`; how long they are kept; how long provider v1 stays available; and whether `error_codes` can hold more than one code.
- A spec shows a slow v3 call ending in the provider's `504` is returned as `AI_SERVICE_TIMEOUT`.
- #1455 is done.

## Consequences

Customers call Speaking and Writing on `/v2` once the gate in decision 10 opens; until then Writing stays on `/v1`. ADR-0138's sunset of `/v1` on 2027-11-02 stays binding, so Writing must reach `/v2` before that date or the owner extends it. Every key in the `/v2` Writing response becomes a customer contract once enabled; further renames are breaking.
