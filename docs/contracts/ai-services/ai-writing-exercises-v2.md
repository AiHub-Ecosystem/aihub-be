# AI Writing exercise provider contract v2

Status: Successful responses were captured from synthetic Production requests
on 2026-11-02. They cover all seven micro exercise types, long-writing
creation, and short- and long-writing grading. The AI Writing team supplied
scrubbed examples for non-400 failures and soft-fail responses in
[issue #1489](https://github.com/AiHub-Ecosystem/aihub-be/issues/1489); those
examples are not independently captured HTTP exchanges. The team also answered
identity-header precedence and its stated storage, telemetry, and log policies
in [issue #1454](https://github.com/AiHub-Ecosystem/aihub-be/issues/1454).
The provider currently reports a 60-second timeout ceiling on all three
operations and plans to enforce 30/20/10 seconds. AIHUB's current 45/35/20
second operation budgets align with the planned limits, not the provider's
current ceiling. Prompt/output logging and onward model-provider retention
remain unspecified.

Owner: AI Writing service. Consumer: AIHUB Public API `/v2` (ADR-0146).

Fixtures: `test/fixtures/ai-writing/micro-*.{request,response,capture}.json` and
`longwriting.{request,response,capture}.json`. Grade fixtures are
`micro-grade-{short,long}-writing.{request,response,capture}.json`. Provider
examples are `provider-error-*.sample.json` and
`provider-fallback-*.response.json`; their provenance is recorded in
this contract and the sample metadata. These examples contain no credentials.

## 1. Operations

| AIHUB operation                                 | Provider operation                     | Request |
| ----------------------------------------------- | -------------------------------------- | ------- |
| `POST /v2/ielts/writing/micro-exercises`        | `POST /v2/create-micro-exercise`       | JSON    |
| `POST /v2/ielts/writing/long-writing-exercises` | `POST /v2/create-longwriting-exercise` | JSON    |
| `POST /v2/ielts/writing/micro-exercises/grade`  | `POST /v2/grading-micro-exercise`      | JSON    |

The base URL is `DOWNSTREAM_AI_WRITING_URL`. Production captures succeeded with
`X-AIHUB-Organization-Id`, `X-AIHUB-User-Id`, and
`X-AIHUB-User-Identity-Mode` using an `org_...` Organization ID. The probes sent
these headers without a bearer token. The dispatcher also sends its configured
bearer token. The AI Writing team confirmed that when any `X-AIHUB-*` identity
header is present, all three headers must be valid; the service authenticates
from those headers and does not verify the bearer token. Missing or invalid
identity headers fail with HTTP 400 and do not fall back to bearer
authentication. The captures did not independently verify a request carrying
both forms.

## 2. Create request shapes

Micro creation accepts one selected error:

```json
{
  "topic": "education",
  "writing_task": 2,
  "criterion": "grammatical_range_accuracy",
  "error_code": "GRA01",
  "prompt": "Use the target form.",
  "question_type": "grammar",
  "image_url": null,
  "comments": [{ "quote": "She go.", "explanation": "Use agreement." }],
  "exercise_type": "short_writing"
}
```

AIHUB maps the flat request to provider `references[]`, with each reference
containing `question.prompt`, `question.image`, `question.question_type`, and
`comments[]`. `grammatical_range_accuracy` maps to the provider's
`grammar_range_accuracy`. If `exercise_type` is omitted or null, AIHUB omits it
from the provider request.

Long-writing creation accepts two to four error objects with the same fields;
AIHUB adds a 1-based `error_no` and wraps each error in provider `references[]`.
Both create routes accept Task 1 images only through an HTTPS public URL. A
captured Task 1 request confirms the provider field `question.image` accepts a
string.

## 3. Grade request shape

The provider body contains `instruction`, `question_no`, `question_text`,
`question_image`, `hint[]`, `sample_answer`, `ai_grading_rubric`, `note`, and
`user_answer`. AIHUB's public request adds `exercise_type` only to select a local
answer-length limit; it is not sent to the provider. Short answers are limited
to 1,500 characters and long answers to 4,000.

## 4. Success response shapes

Create responses have `success`, `message`, `data`, `usage`, and `metrics`.
`data.meta` contains `id`, `type`, `ai_grading`, `error_code`, `difficulty`,
`topic`, `instruction`, and `number_of_questions`. Micro responses also include
`rationale_for_exercise` (string or null); their `error_code` is a string. Long
responses use an `error_code[]` and do not include the rationale field. Each
`data.exercise[]` row contains `questions_no`, `question_text`,
`question_image`, and `explanation`.

The captured micro exercise variants are:

| `meta.type`                | Additional exercise fields                                            |
| -------------------------- | --------------------------------------------------------------------- |
| `multiple_choice_single`   | `options` object with A–D; `correct` string                           |
| `multiple_choice_multiple` | `options` object with A–D; `correct[]`                                |
| `choose_from_list`         | `options[]`; `correct` string                                         |
| `gap_filling`              | `correct[]`                                                           |
| `annotation`               | `text_for_annotation`; `correct[]`                                    |
| `reorder`                  | `options[]`; `correct` string                                         |
| `short_writing`            | `hint[]`; `correct` with `sample_answer`, `ai_grading_rubric`, `note` |

Long-writing exercise rows include `hint[]` and `correct.sample_answer` plus
`correct.ai_grading_rubric`. Grading responses have `data.score` and
`data.comment`. AIHUB publishes only the validated `data` fields, not provider
`message`, `usage`, `cost`, or `metrics`; usage and processing time remain
available to internal metering.

The adapter checks that `number_of_questions` equals the returned exercise
array length. One captured annotation response answered HTTP 200 with an empty
array despite reporting ten questions; AIHUB rejects that response as a
contract violation.

## 5. Provider-confirmed errors and soft failures

The provider confirms the same non-400 failure behavior on all three routes:

| Provider response     | AIHUB error            | Notes                                                               |
| --------------------- | ---------------------- | ------------------------------------------------------------------- |
| `429 rate_limited`    | `AI_SERVICE_THROTTLED` | Provider sends `Retry-After: 30`; AIHUB preserves it.               |
| `500 internal_error`  | `AI_SERVICE_ERROR`     | Uses the dispatcher's status mapping.                               |
| `504 gateway_timeout` | `AI_SERVICE_TIMEOUT`   | The exercise adapter names the timeout; provider text is discarded. |

The scrubbed response examples came from the provider's written answer rather
than live error exchanges. Captured HTTP 400 error envelopes have `success`,
`status_code`, `error_code`, `message`, `detail`, and `details`. AIHUB reads
only provider error codes needed for safe mapping and never forwards provider
text. An invalid error code and a `GRA02` + `reorder` combination were captured
as HTTP 400 `invalid_request` and map to `INVALID_REQUEST`.

The provider confirms all three operations can return HTTP 200 soft-fail
fallbacks after parsing or schema validation fails. The micro annotation empty
response is a Production capture; long-writing and grading examples were
supplied in the provider's written answer. AIHUB rejects them at its response
schema boundary: exercises require at least one question, and a micro grade
requires a score from 1 through 10. These failures become
`AI_SERVICE_CONTRACT_VIOLATION`, are not customer-billable, and do not increment
customer quota. The provider says it absorbs the upstream model cost for these
fallbacks.

The provider currently reports a 60-second timeout ceiling for each route. It
plans to enforce 30 seconds for micro creation, 20 seconds for long-writing
creation, and 10 seconds for grading. AIHUB's 45/35/20 second operation
budgets and nginx's 55/45/30 second edge budgets align with those planned
ceilings. Until the provider deploys them, AIHUB may time out first and cannot
rely on receiving the provider's own 504.

Provider telemetry contains `usage.input_tokens`, `usage.output_tokens`,
`usage.total_tokens`, `usage.cost`, and `metrics.ai_processing_ms`. The adapter
does not expose cost or token counts to the customer; for schema-valid
responses, the gateway extracts approved usage and processing-time fields for
metering. A soft-fail response rejected at the schema boundary does not reach
the metering finalizer with provider usage or cost.

The AI Writing team reports that it does not store exercise, answer, or grading
data in Postgres or S3. Its telemetry contains the user ID, endpoint, token
counts, cost, and latency; telemetry is retained for 30–90 days and
user-specific telemetry can be purged on request. Uvicorn INFO logs contain
request metadata and rotate every 7–14 days. The team did not specify whether
those logs include prompts or outputs. Retention or deletion by onward model
providers remains unknown.
