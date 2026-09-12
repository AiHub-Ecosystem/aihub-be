# AI Speaking grading provider contract v1

Status: Draft for AI Speaking provider and WISPACE approval.

Owner: AI Speaking service. Consumer: the AIHUB gateway.

Sources: `API_Grading.md`, the D2 implementation contract, and
`test/fixtures/ai-speaking/grading.response.json`. The fixture is currently
contract-based and must be replaced or approved from an authenticated Dev
response before anyone claims live compatibility.

## 1. Scope and endpoint ownership

The provider exposes two synchronous grading transports:

| Provider operation                   | Content type          | Role                                                           |
| ------------------------------------ | --------------------- | -------------------------------------------------------------- |
| `POST /api/v1/speaking/grading`      | `multipart/form-data` | Primary audio-file path; proxied by AIHUB D2.                  |
| `POST /api/v1/speaking/grading-json` | `application/json`    | Audio-URL fallback; not exposed by the current AIHUB D2 route. |

AIHUB currently exposes only `POST /v1/speaking/grading`. The future public
`POST /v1/speaking/grade` asset/job operation is a separate asynchronous
contract and is not part of this document.

## 2. Authentication and trust boundaries

- Every provider request requires `x-client-id` and `x-secret-key`.
- AIHUB reads those values from environment-specific secret management and
  sends them server-side. They must never be request fields, browser values,
  logs, fixtures, or public errors.
- The provider owns credential validation and rotation. AIHUB owns the outbound
  configuration used to call the provider; neither side should persist the
  secret in ordinary business data.
- `user_id` is required by the provider, but AIHUB derives it from the
  verified `X-User-Assertion`. A client-supplied identity must not override it.

## 3. Multipart request contract

`POST /api/v1/speaking/grading` accepts exactly one audio file and the fields
below. Unknown or duplicate fields are invalid.

| Field         | Type    | Required | Contract                                                                  |
| ------------- | ------- | -------- | ------------------------------------------------------------------------- |
| `audio`       | file    | yes      | `wav`, `mp3`, `m4a`, `webm`, or `ogg`; 100 bytes minimum, 25 MiB maximum. |
| `user_id`     | string  | yes      | Verified learner identity supplied by AIHUB.                              |
| `part`        | integer | yes      | `1`, `2`, or `3`.                                                         |
| `question_id` | string  | yes      | Non-empty question-bank identifier.                                       |
| `prompt_text` | string  | no       | Prompt used for relevance analysis.                                       |
| `test_type`   | string  | no       | For example `Practice` or `Full-test`.                                    |
| `test_code`   | string  | no       | Correlates questions in one full test.                                    |
| `transcript`  | string  | no       | Existing transcript; skips provider STT when supported.                   |

The provider must treat the audio bytes and text fields as untrusted input,
enforce the stated limits, and return a documented 4xx response rather than a
successful body when validation fails.

## 4. JSON audio-URL fallback

`POST /api/v1/speaking/grading-json` uses the same metadata as the multipart
operation but replaces `audio` with `audio_url`:

```json
{
  "user_id": "verified-by-aihub",
  "part": 1,
  "question_id": "p1_hometown",
  "prompt_text": "Do you enjoy living in your hometown?",
  "audio_url": "https://approved-object-storage.example/audio.mp3",
  "test_type": "Practice",
  "test_code": "FULL-TEST-001",
  "transcript": null
}
```

The provider must document the approved URL schemes, host policy, redirect
policy, download timeout, and downloaded-size limit. AIHUB must validate an
allowlisted HTTPS URL before this operation is exposed; an arbitrary URL is not
an acceptable public contract.

## 5. Success response contract

The provider success body is a JSON object with `status: "success"` and a
`data` object. The following groups are the contract consumed by AIHUB:

| Group                  | Required fields                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `scorability`          | `is_scorable`, `confidence`, `display_band`, `message_vi`                                                                    |
| `estimated_band`       | `overall`, `fluency_coherence`, `lexical_resource`, `grammatical_range_accuracy`, `pronunciation`; each is 0–9 in 0.5 steps. |
| `transcript`           | `text`, non-negative `word_count`, non-negative `duration_seconds`                                                           |
| `relevance`            | `on_topic`, `score` from 0–1, `feedback_vi`                                                                                  |
| `fluency_metrics`      | non-negative `speech_rate_wpm`, `pause_count`, `mean_length_run_words`                                                       |
| `pronunciation_detail` | `summary` counts plus per-word `word`, scores/classes, `syllables`, and `phonemes`                                           |
| `language_analysis`    | `grammar_errors` and `vocabulary_upgrades` with the documented text fields                                                   |
| `feedback`             | `summary_vi`, `strong_point_vi`, `action_plan_vi`                                                                            |
| `performance_timing`   | non-negative processing durations, including total, acoustic, language, STT, and provider sub-pipeline timings               |

`question_id` is required in `data`; `test_type` may be a string or `null`.
Provider-only identifiers such as `session_id`, `test_id`, and `user_id` may be
present for internal tracing but are not part of the AIHUB public response.

The machine-enforced boundary is
`src/contracts/speaking/grading.ts`. A 2xx body that does not satisfy that
contract is a contract violation; AIHUB does not guess missing fields or pass
through the raw provider envelope.

## 6. AIHUB normalized response

AIHUB returns the shared `{ data, meta }` envelope. `data` contains only the
approved scoring groups above plus `question_id` and optional `test_type`.
Provider envelopes, credentials, assertions, audio, private IDs, and raw
provider details never cross the public boundary.

## 7. Error contract

The provider should keep these statuses stable and use a machine-readable
body such as `{ "detail": "..." }` for diagnostics:

| Status | Meaning                                      |
| ------ | -------------------------------------------- |
| `400`  | Invalid or missing metadata/audio.           |
| `401`  | Missing or invalid provider credentials.     |
| `413`  | Audio or request exceeds the provider limit. |
| `429`  | Provider throttling.                         |
| `5xx`  | Provider or pipeline failure.                |

AIHUB maps statuses to shared error categories and never exposes `detail` or
raw response bodies to the client. Provider logs and errors must not contain
secret headers or raw audio.

## 8. Compatibility and change control

- Additive optional response fields are non-breaking only when they are outside
  the normalized contract and do not change the meaning of existing fields.
- Renaming/removing fields, changing types/ranges/nullability, changing enum
  values, or changing error semantics requires a versioned review and a new
  approved fixture before deployment.
- Provider, WISPACE, and AIHUB must approve the fixture and update this file,
  the machine schema, and the integration tests together.
