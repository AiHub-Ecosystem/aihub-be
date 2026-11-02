# AI Writing exercise provider contract v2

Status: Captured from synthetic Production requests on 2026-11-02. Successful
responses cover all seven micro exercise types, long-writing creation, and
short- and long-writing grading. The AI Writing team has also answered
identity-header precedence and its stated storage, telemetry, and log policies
in [issue #1454](https://github.com/AiHub-Ecosystem/aihub-be/issues/1454).
Captures do not verify provider timeout behavior or non-400 failures. The team
did not specify whether prompts or outputs appear in Uvicorn logs or how onward
model providers retain data.

Owner: AI Writing service. Consumer: AIHUB Public API `/v2` (ADR-0146).

Fixtures: `test/fixtures/ai-writing/micro-*.{request,response,capture}.json` and
`longwriting.{request,response,capture}.json`. Grade fixtures are
`micro-grade-{short,long}-writing.{request,response,capture}.json`. They contain
synthetic content; capture metadata contains no credentials.

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

## 5. Captured errors

The captured error envelope has `success`, `status_code`, `error_code`,
`message`, `detail`, and `details`. AIHUB reads only `error_code` and maps a
captured HTTP 400 `invalid_request` to `INVALID_REQUEST`; it never forwards
provider text. An invalid error code and a `GRA02` + `reorder` combination both
produced this refusal. Other provider errors have not been captured and use
AIHUB's default status mapping.

Provider telemetry contains `usage.input_tokens`, `usage.output_tokens`,
`usage.total_tokens`, `usage.cost`, and `metrics.ai_processing_ms`. The adapter
does not expose cost or token counts to the customer; the gateway extracts
approved usage and processing-time fields for metering.

The AI Writing team reports that it does not store exercise, answer, or grading
data in Postgres or S3. Its telemetry contains the user ID, endpoint, token
counts, cost, and latency; telemetry is retained for 30–90 days and
user-specific telemetry can be purged on request. Uvicorn INFO logs contain
request metadata and rotate every 7–14 days. The team did not specify whether
those logs include prompts or outputs. Retention or deletion by onward model
providers remains unknown.
