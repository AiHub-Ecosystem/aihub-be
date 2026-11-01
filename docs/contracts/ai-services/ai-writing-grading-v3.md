# AI Writing grading provider contract v3

Status: Request, headers, errors and business response verified against the AI
Writing team's integration document v3.1 (2026-10-30), two real captures
(2026-11-01) and probes of the provider's Test and Production environments
(2026-11-01). Written confirmations still open: #1457 (Organization ID format,
authentication, `error_codes`, how long v1 stays available) and #1456 (data
scoped by Organization and End-User, how long it is kept).

Owner: AI Writing service. Consumer: the AIHUB gateway, for Public API `/v2`
(ADR-0143). `/v1` Writing keeps using the v1 contract
([ai-writing-grading-v1.md](ai-writing-grading-v1.md)).

Fixtures: `test/fixtures/ai-writing/grade-v3-task1.{request,response}.json` and
`grade-v3-task2.{request,response}.json`. Redacted telemetry captures are in
`grade-v3-task{1,2}.telemetry.capture.json`; they contain no essay and no
provider text. Each task was captured once.

The provider's document also holds test credentials and a sample token. They are
not copied here or anywhere in this repository.

## 1. Scope and endpoint ownership

| Public AIHUB operation               | Provider operation                | Request |
| ------------------------------------ | --------------------------------- | ------- |
| `POST /v2/ielts/writing/task1/grade` | `POST /v3/grading-feedback-task1` | JSON    |
| `POST /v2/ielts/writing/task2/grade` | `POST /v3/grading-feedback-task2` | JSON    |

The base URL is the same origin AIHUB already uses for `/v1` Writing
(`DOWNSTREAM_AI_WRITING_URL`). The micro-exercise operations of the provider
(`create-micro-exercise`, `create-longwriting-exercise`, `grading-micro-exercise`,
in v1 and v2) are not part of this contract; they are tracked in #1454.

## 2. Authentication and identity

- AIHUB sends three headers on every v3 call: `X-AIHUB-Organization-Id`,
  `X-AIHUB-User-Id` and `X-AIHUB-User-Identity-Mode`
  (`signed_assertion` or `declared_id`). If any `X-AIHUB-*` header is sent, all
  three are required; a missing or malformed one answers `400 invalid_request`
  naming the header.
- **`X-AIHUB-Organization-Id` must be a 36-character UUID.** An `org_...` ID,
  which AI Speaking accepts, answers `400` on both the Test and the Production
  environment (probed 2026-11-01). AIHUB therefore sends a UUIDv5 of its
  Organization ID in a fixed namespace (ADR-0143 decision 13). The namespace is
  permanent: the provider keys a learner's history by the value it receives.
- AIHUB also sends the existing bearer token, as for `/v1`. The provider document
  offers the headers or a JWT as alternatives, and a request with neither
  answers `401 unauthorized`. How the provider treats a request that carries both
  is an open question (#1457).
- Provider credentials, essays and raw provider bodies must not be logged or
  returned in errors.

## 3. Request contract

AIHUB maps its public request to the provider body. Unknown public fields are
invalid.

| Provider field | Task 1                       | Task 2                       |
| -------------- | ---------------------------- | ---------------------------- |
| `question`     | `question`                   | `question`                   |
| `topic`        | `chart_type` (Task 1 only)   | `topic`                      |
| `url`          | `image_url` (HTTPS)          | not sent                     |
| `essay`        | `essay` (1000 words at most) | `essay` (1000 words at most) |

The provider refuses an essay of more than 1000 words with `413`. AIHUB refuses
it first with `INVALID_REQUEST`.

## 4. Response contract

The body is `{ success, data_micro, data, usage, metrics }`.

- `data.overall_band`, `data.evaluation` (four criteria keyed
  `1_task_achievement` or `1_task_response`, then `2_coherence_cohesion`,
  `3_lexical_resource`, `4_grammatical_range_accuracy`) and
  `data["Overall Assessment"]` with `Summary` (`Overall`, `Detail[]`, `CTA`) and
  `Progress` (`status`, `error_recur[]`, `error_impro[]`, `error_new[]`).
- Each criterion has `band_score`, `band_reason`, `strengths[]`,
  `areas_for_improvement[]`, `errors[]` (`quote`, `error_codes`, `error_name`,
  `explanation`, `improved_version`), `suggestions[]` (`quote`, `explanation`,
  `improved_version`) and `feedback_detail[]`.
- `data_micro` is `{ criterion: { code: { prompt, question_type, comments[] } } }`,
  `{}` when there is no error. The 48 error codes are `TA01–06`, `TR01–08`,
  `CC01–08`, `LR01–07` and `GRA01–19`.
- `data.coT`, `data.task`, `usage` and `metrics` are not published. AIHUB reads
  `usage` and `metrics` for metering only.

`error_codes` is a single string in both captures. Whether it can hold several
codes is unconfirmed (#1457). An element shape for the `Progress` lists other than
strings is not in the captures.

## 5. Errors

Error body: `{ success: false, status_code, error_code, message, detail,
details }`. AIHUB reads `error_code`, never forwards `message`, and maps:

| Provider | `error_code`        | AIHUB error                                                                              |
| -------- | ------------------- | ---------------------------------------------------------------------------------------- |
| 504      | `gateway_timeout`   | `AI_SERVICE_TIMEOUT`                                                                     |
| 413      | `payload_too_large` | `INVALID_REQUEST`                                                                        |
| 422      | `image_unreadable`  | `INVALID_REQUEST`                                                                        |
| 429      | `rate_limited`      | `AI_SERVICE_THROTTLED` (default status mapping)                                          |
| other    | any                 | the default status mapping (`AI_SERVICE_ERROR`, `AI_SERVICE_UNAVAILABLE` for 401 or 403) |

The provider gives up after 120 seconds. The AIHUB budget is 125 seconds and the
edge allows 135 (ADR-0143). No real `504` body has been captured; the mapping
follows the provider document.
