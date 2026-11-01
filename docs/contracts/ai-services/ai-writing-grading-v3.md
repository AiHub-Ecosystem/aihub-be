# AI Writing grading provider contract v3

Status: Request, headers, errors and business response verified against the AI
Writing team's integration document v3.1 (2026-10-30), two real captures
(2026-11-01) and probes of the provider's Test and Production environments
(2026-11-01). The AI Writing team answered the contract questions in writing on
2026-11-01 (#1457, comment of that date); the answers are recorded below as the
provider's statements. Still open: a probe confirming that v3 now accepts
`org_...` Organization IDs, and #1456 (stored data scoped by Organization and
End-User, confirmed against evidence rather than a statement).

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
- **`X-AIHUB-Organization-Id`.** A probe on 2026-11-01 (09:19 UTC) showed that
  both the Test and the Production environment rejected an `org_...` ID and
  accepted only a 36-character UUID. AIHUB therefore sends a UUIDv5 of its
  Organization ID in a fixed namespace (ADR-0143 decision 13). The provider
  states in writing (2026-11-01, #1457 question 1) that v3 now accepts
  `org_[A-Za-z0-9_-]{1,60}` as well, case-sensitively, and a UUID (normalized to
  lowercase), and that `org_...` is the permanent first-class format. This has
  not been probed since. Until it is, and until the owner decides to switch,
  AIHUB keeps sending the UUIDv5: the provider keys a learner's history by the
  value it receives, so changing the value starts every learner's `Progress`
  again.
- **`X-AIHUB-User-Id`** is 1 to 256 visible ASCII characters (no spaces, control
  characters or non-ASCII). **`X-AIHUB-User-Identity-Mode`** is
  `signed_assertion` or `declared_id`.
- A missing, blank, over-long or malformed identity header answers `400
invalid_request` naming the header. The provider states that it never falls
  back to another user, a default account or a shared bucket (#1457 question 3).
- The provider identifies the caller by the three headers. It states that with
  all three present nothing else is required: the `Authorization` bearer token
  is optional and not evaluated, and no client id or secret is needed (#1457
  question 2). AIHUB still sends the existing bearer token, as for `/v1`. A
  request with neither the three headers nor a valid bearer token answers `401
unauthorized`.
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

`error_codes` is a single string in both captures. The provider confirms that an
error response carries one `error_code` string, never several (#1457 question
4). An element shape for the `Progress` lists other than strings is not in the
captures.

The provider states that the v3 response schema is frozen, that future changes
only add optional fields, and that a breaking change gets a written notice at
least 30 days ahead (60 days for an architectural overhaul), ships under a new
major version such as `/v4`, and runs next to `/v3` for at least 6 months
(#1457 question 11).

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
edge allows 135 (ADR-0143). The provider supplied the body of its `504`
(2026-11-01, #1457 question 5): `success: false`, `status_code: 504`,
`error_code: "gateway_timeout"`, a message that the grading pipeline timed out
after 120 seconds, the same text in `detail`, and `details: null`. It is not
stored as a fixture: it is a description from the provider, not a capture
AIHUB took.

Every `error_code` the provider says the two grading endpoints can return:
`invalid_request` (400), `unauthorized` (401), `payment_required` (402, only in
the provider's legacy token mode), `not_found` (404), `payload_too_large` (413,
essay over 1000 words), `image_unreadable` (422, Task 1 chart URL missing,
invalid or unreadable), `unprocessable_entity` (422), `rate_limited` (429, with
`Retry-After`), `internal_error` (500), `bad_gateway` (502) and
`gateway_timeout` (504). AIHUB maps the ones in the table above and takes the
default status mapping for the rest.

## 6. Stored data, retention and v1

Provider statements of 2026-11-01 (#1457 questions 7 to 9, and 6). They are not
independent evidence; the isolation evidence is tracked in #1456.

- **What v3 stores per graded essay:** the student's identity record keyed by
  Organization and End-User ID, the submission (the essay text, its counts and
  the time spent), the grading session (band scores, summary, model versions,
  latency and the full evaluation payload, which holds `Progress`), the
  individual error findings, and the longitudinal weakness history. A separate
  usage log keeps per-call model, token counts, cost and latency. A Task 1 chart
  cache is keyed by image URL and holds no personal data.
- **Scoping:** the provider states that submissions and user records are
  partitioned by the pair `(Organization ID, End-User ID)`, that no endpoint reads
  across Organizations, and that a lookup of another Organization's record answers
  `404` or an empty set. Confirmation that the weakness history uses the same
  pair is still requested (#1456).
- **Retention:** submissions, grading sessions, error findings and weakness
  history are kept without a limit (or for the partner contract); the usage log
  for at least one year; the chart cache without a limit.
- **Deletion:** there is no deletion API. The provider deletes one End-User's data
  on a formal request to its operations team, within 24 business hours, and
  confirms it. Identifiers for such a request go to the provider through a
  private channel, never in a public issue.
- **Provider `/v1`:** stays available until AIHUB has moved all traffic to v3,
  and for one more month after that. It is removed only after that month ends
  without blocking issues.

### Follow-ups the provider agreed (relayed 2026-11-01)

The AIHUB owner reports on 2026-11-01 that the AI Writing team has made the
changes it agreed after #1457: it deleted the test records AIHUB created while
verifying the release, it changed the key of the weakness history to the pair
`(Organization ID, End-User ID)`, and it changed how v3 authenticates AIHUB's
calls. The provider has not posted this in writing and AIHUB has not verified it.
AIHUB has not changed what it sends: the three `X-AIHUB-*` headers and the
existing bearer token, with the UUIDv5 Organization ID. The authentication
scheme the provider now expects is not recorded here; replace this paragraph
with the scheme and a dated smoke call to each `/v2` Writing route when AIHUB
has them (#1456).
