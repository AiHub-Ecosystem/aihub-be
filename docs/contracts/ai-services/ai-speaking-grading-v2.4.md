# AI Speaking grading provider contract v2.4

Status: The provider reports v2.4 deployed to Production on 2026-10-31. This
records upstream behavior; AIHUB's public `/v2` request/response contract and
release approval remain pending under [ADR-0138](../../adr/0138-batch-ai-service-breaking-changes-into-public-v2.md).

Owner: AI Speaking service. Consumer: the AIHUB gateway.

Sources: the provider's v2.4 integration guide updated 2026-10-29, its
2026-10-31 response to AIHUB's identity-header questions, and sanitized
Production response captures in `test/fixtures/ai-speaking/`. The provider
reports that all captured traffic used synthetic test data. There is no
staging environment. Credentials, audio, transcripts, feedback text, and raw
response strings are not stored in the fixtures.

Written provider answers received on 2026-11-02 and 2026-11-03 are recorded
below ([#1450, answers 2–4](https://github.com/AiHub-Ecosystem/aihub-be/issues/1450#issuecomment-6581758654),
[#1450, answer 10](https://github.com/AiHub-Ecosystem/aihub-be/issues/1450#issuecomment-6608652752)).

On 2026-10-31, AI Speaking deployed commit `148f126` to accept AIHUB's opaque
`org_...` Organization IDs while retaining legacy UUID support. A controlled
Production question-grade request using a synthetic `org_...` ID returned
`question_result`; retrieving that result with the same identity headers also
returned `200`.

## 1. Operations

| Provider operation                             | Request               | Result                   |
| ---------------------------------------------- | --------------------- | ------------------------ |
| `POST /api/v2/speaking/questions/grading`      | `multipart/form-data` | `question_result`        |
| `GET /api/v2/speaking/responses/{response_id}` | none                  | Stored `question_result` |
| `POST /api/v2/speaking/parts/grading`          | JSON                  | `part_result`            |
| `GET /api/v2/speaking/parts/{part_result_id}`  | none                  | Stored `part_result`     |
| `POST /api/v2/speaking/tests/grading`          | JSON                  | `test_result`            |
| `GET /api/v2/speaking/tests/{test_id}`         | none                  | Latest `test_result`     |

The service is available at
`https://api-ielts-speaking.aihubproduction.com`; the provider reports no
staging environment. Part and test grading aggregate stored question results
and do not accept audio.

## 2. Authentication and identity headers

Every operation requires `x-client-id` and `x-secret-key`. The provider
validates these credentials before it examines identity headers; missing or
invalid credentials produce `401 unauthorized`.

All six v2.4 operations also require these headers:

| Header                       | Provider validation                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-AIHUB-Organization-Id`    | AIHUB ID: `org_` plus 1–60 ASCII letters, digits, `_`, or `-`; exact and case-sensitive. Legacy 36-character UUIDs remain accepted and normalized to lowercase. |
| `X-AIHUB-User-Id`            | 1–256 visible ASCII characters (`!` through `~`), with no spaces or Unicode.                                                                                    |
| `X-AIHUB-User-Identity-Mode` | `signed_assertion` or `declared_id`.                                                                                                                            |

After successful credential validation, a missing or malformed identity
header produces `400 invalid_request` and names the offending header.
Requests no longer need `user_id` in multipart fields, JSON bodies, or query
parameters. If supplied for compatibility, the provider ignores it. The
response `data.meta.user_id` is still present and echoes the value from
`X-AIHUB-User-Id`.

These are service-to-service headers. AIHUB derives the Organization ID from
the authenticated API key and the End-User ID and mode from the server-resolved
User Identity; it never forwards identically named headers supplied by a
customer. `RequestContext` carries all three trusted values to both Speaking
grading adapters.

## 3. Request bodies

`POST /questions/grading` requires multipart fields `part` (1–3),
`question_id`, and one audio file (100 bytes to 25 MB). Optional fields are
`prompt_text`, `test_type` (`Practice` or `Full-test`), `test_code`, and
`part_result_id` (maximum 64 characters). The request has no `user_id` field.

`POST /parts/grading` requires JSON `part_result_id`. It may also receive
`part`, `test_id`, `test_type`, `expected_question_count`, and `response_ids`.
`POST /tests/grading` requires `test_id`; `test_type`, `part_result_ids`, and
`response_ids` are optional, but at least one of `part_result_ids` or
`response_ids` must identify results to aggregate. Neither JSON request has a
`user_id` field. The three GET operations identify their result in the path.

The provider accepts `Practice`, `Full-test`, and `full_test` for `test_type`,
case-insensitively. Question grading defaults it to `Practice`; Part and Test
aggregation can omit it, in which case the stored question value is used.
Responses return `practice` or `full_test` in `data.meta.test_type`.

Question grading trims `test_code` and stores it as that result's `test_id`,
also returned in `data.meta.test_id`. An omitted or empty `test_code` stores
`null`. For Test aggregation with `test_id: Y`, each referenced answer must
have a stored `test_id` of `null` or exactly `Y` (case-sensitive); another
value produces `422 mixed_tests`, even if all answers share that other value.
Part aggregation does not compare its request `test_id` with stored values. It
returns `422 mixed_tests` only if answers for that `part_result_id` contain two
or more distinct non-null stored `test_id` values. The request `test_id` labels
the Part result; when omitted, the stored value is used.

## 4. Responses and errors

Success responses use `{ status, error, usage, data }`. The provider says all
documented fields remain present; fields not applicable at that result level
are `null`, while an empty array means the group applies and has no entries.
`data.meta.schema_version` is `2.4`; `result_type` is `question_result`,
`part_result`, or `test_result`. The numeric band fields for individual
criteria are integers from 0–9; `overall` is a number in 0.5 steps.

The provider's principal error responses are:

| HTTP      | `error.code`                                           | Meaning                                                                 |
| --------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| 400       | `invalid_request`                                      | Missing/malformed identity header or invalid request fields.            |
| 401       | `unauthorized`                                         | Missing or incorrect service credentials.                               |
| 404       | `not_found`, `part_not_found`, or `response_not_found` | Missing result or result outside the requesting Organization/User pair. |
| 422       | `audio_unreadable` and aggregation errors              | Unreadable audio or incompatible stored results.                        |
| 429       | `rate_limited`                                         | Provider overloaded; documentation specifies `Retry-After: 5`.          |
| 500       | `internal_error`                                       | Unclassified provider failure.                                          |
| 502 / 504 | service-specific grading error / `timeout`             | Transcription, acoustic, language, or deadline failure.                 |
| 503       | `storage_unavailable`                                  | Temporary result-store failure on retrieval.                            |

All observed failures use the provider envelope with `usage: null` and
`data: null`. Clients should branch on `error.code`, not the mutable message.
The supplied captures do not include a `429`, `502`, `503`, or `504` response.

For both aggregation POSTs, the provider's written list of `422` codes is:

| `error.code`           | Provider-stated condition                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `mixed_tests`          | Referenced answers do not satisfy the Test or Part `test_id` grouping rules above.                  |
| `mixed_parts`          | Answers in one `part_result_id` span multiple Parts, or two groups in one Test cover the same Part. |
| `not_v2_result`        | A referenced answer is not a stored v2.4 question result.                                           |
| `mixed_scorer_engines` | Referenced answers were scored by different engines.                                                |

The provider says these four codes mean the request combined answers that do
not belong together and share the standard error envelope. A real
`mixed_tests` capture is in the fixtures; the other three codes have written
descriptions but no captured response yet.

## 5. Tenant storage and v1 compatibility

The provider says question, Part, and test records are stored and retrieved by
the pair `(org_id, user_id)`. Identity mode is stored with results. Reads and
aggregation are scoped to the same pair; a result belonging to another User
or Organization is returned as `404`, not `403`. `part_result_id` and
`test_id` need only be unique within that pair. Audio object paths include both
IDs.

The provider reports that v1 accepts the three new identity headers without
rejecting requests and continues to require the legacy `user_id` body field.
When a valid Organization header is present, v1 uses its `org_...` or UUID
value for new records; an absent or malformed optional identity-header set
retains the previous default Organization. Existing v1 records are not
migrated and v2.4 cannot read them.

The provider stated on 2026-11-02 that stored results do not expire
automatically and remain until the Organization asks for deletion. It will
notify AIHUB before introducing an expiry. Question grading normally persists
the result before returning, so it is available to read or aggregate
immediately; v2.4 has no one-to-two-second read delay. Part and Test
aggregation wait briefly for answers still being saved before returning 404.
In the rare case that the question result write fails, the provider may still
return the grade and later reads return 404; the caller should re-grade the
question, since retrying the read will not help.

## 6. AIHUB integration status

AIHUB's Integration Guide documents customer Organization IDs as opaque
`org_...` strings. AI Speaking commit `148f126` now accepts those IDs directly
and retains legacy UUID support, so AIHUB does not need a derived mapping. The
Production POST and GET smoke above verifies one synthetic Organization/User
pair only; cross-Organization isolation still needs its separate evidence in
#1456. Existing v1 records are not migrated.

The captures demonstrate two question results in one Part 1 flow, Part/Test
aggregation, reads, header/auth failures, unreadable audio, a cross-User 404,
and a complete three-Part exam (#1478). They do not constitute AIHUB approval
of the public `/v2` response schema. WISPACE and AIHUB review remain required
under [ADR-0138](../../adr/0138-batch-ai-service-breaking-changes-into-public-v2.md).
