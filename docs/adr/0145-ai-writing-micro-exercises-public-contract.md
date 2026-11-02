# ADR-0145: Serve AI Writing micro-exercises through Public API v2

- Status: Proposed — request/response captures and route-level error/timeout handling are recorded. Provider timeout behavior, prompt/output logging, and onward model-provider retention remain unverified.
- Date: 2026-11-02
- Amends: [ADR-0143](0143-public-v2-serves-ai-writing-v3-grading.md) decision 3, which promises that customers send `data_micro` back unchanged
- Related: [ADR-0100](0100-writing-task1-chart-image-uploads.md), [ADR-0127](0127-public-api-uri-major-versioning.md), [ADR-0129](0129-public-route-and-response-convention.md), [ADR-0140](0140-tenant-identity-is-the-organization-and-end-user-id-pair.md), [#1454](https://github.com/AiHub-Ecosystem/aihub-be/issues/1454)

## Context

Issue #1454 adds create-micro-exercise, create-longwriting-exercise, and grading-micro-exercise. The existing public `data_micro` object is trait → code → `{ prompt, question_type, comments[] }`; the provider instead asks AIHUB to select specific errors and supply other operation fields. The public request therefore needs an AIHUB-owned shape and mapping. Synthetic Production captures now cover all seven micro response types, long-writing creation, short- and long-writing grading, Task 1 image input, and two provider refusals. Their captured contract is recorded in [AI Writing exercise provider contract v2](../contracts/ai-services/ai-writing-exercises-v2.md). The AI Writing team has confirmed header precedence, exercise-data storage, telemetry retention, and Uvicorn log rotation in its written response on [issue #1454](https://github.com/AiHub-Ecosystem/aihub-be/issues/1454). Provider timeout behavior, whether prompts or outputs appear in Uvicorn logs, and onward model-provider retention remain unverified.

## Decision

- Add `POST /v2/ielts/writing/micro-exercises`, `POST /v2/ielts/writing/long-writing-exercises`, and `POST /v2/ielts/writing/micro-exercises/grade`, following ADR-0129.
- Give all three operations the `writing.exercise` scope and distinct metering operation names. Require `Idempotency-Key` for each. Successful response bodies are retained for replay for 24 hours in the existing idempotency store. The provider stores no exercise state, but AIHUB consequently retains generated exercises and answer keys, or grading scores and feedback, for that replay window; only a request fingerprint is stored for the request.
- A create-micro request selects one error entry from `data_micro`; create-longwriting selects two to four. Requests contain the needed topic, writing task, criterion, error code, prompt, question type, comments, and any supported image reference. Customers do not need to prove that they previously called grading. AIHUB validates its public request and maps it to the provider schema; it does not pass `data_micro` through as an opaque body.
- Expose the provider's seven micro exercise types on the micro route and `long_writing` through the long-writing route, after evidence exists for each exposed response shape. `exercise_type` may be omitted or null to let the provider choose a compatible micro type; the response identifies the result through `meta.type`.
- Treat micro grading's integer score from 1 to 10 as a practice score, not an IELTS band score or verified result tied to a particular generated exercise. The provider returns no exercise identifier and is stateless. Client-graded exercise types include `correct` in the response; the customer application is responsible for keeping answer keys from learners until appropriate.
- AIHUB owns the public response schema and models exercise variants as a union discriminated by `meta.type`. Preserve exercise content and answer keys, and omit provider `usage`, `cost`, `metrics`, and `message` from the customer response, consistent with ADR-0143.
- Allow API keys with `writing.exercise` to use the existing authenticated Writing chart upload and completion flow for exercise images. Keep ADR-0100's image validation, public delivery, retention, and upload limits; AIHUB does not fetch arbitrary image URLs.
- Limit each public request body to 256 KiB and enforce provider field limits locally: topic 200 characters, prompt 2,000, quote/explanation 1,000, image URL 2,048, and user answer 1,500 for short writing or 4,000 for long writing. Use AIHUB timeouts of 45 seconds for micro creation, 35 seconds for long-writing creation, and 20 seconds for micro grading. Set nginx timeouts 10 seconds higher: 55, 45, and 30 seconds respectively.

## Evidence required before release

- Capture timeout and additional provider error behavior, especially the provider's long-running failure path. AIHUB's route-level tests cover sanitized provider refusals and the configured timeout response, but do not establish the provider's own slow-failure behavior.
- Confirm whether request prompts or outputs appear in Uvicorn logs and how onward model providers retain or delete data. The AI Writing team reports no exercise, answer, or grading data stored in Postgres/S3, telemetry retained for 30–90 days with user-specific purge on request, and Uvicorn request-metadata logs rotated every 7–14 days; payload logging details remain unspecified.
- AIHUB's 24-hour idempotency replay retention is documented in the personal data inventory as a replay deadline, not a deletion guarantee.
- Keep provider compatibility between error-code and exercise-type combinations provider-owned. A captured `GRA02` + `reorder` request was refused with `400 invalid_request`; AIHUB returns `INVALID_REQUEST` and does not guess which combinations are supported.

The captured contract is pinned for implementation, while the open evidence above remains a release risk.
