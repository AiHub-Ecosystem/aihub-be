# AI Writing grading provider contract v1

Status: Verified against live AI Writing responses captured on 2026-09-07.

Owner: AI Writing service. Consumer: the AIHUB gateway.

Fixtures: `test/fixtures/ai-writing/grade-task1.response.json` and
`test/fixtures/ai-writing/grade-task2.response.json`.

## 1. Scope and endpoint ownership

The current AIHUB gateway exposes the two grading operations below:

| Public AIHUB operation               | Provider operation             | Request |
| ------------------------------------ | ------------------------------ | ------- |
| `POST /v1/ielts/writing/task1/grade` | `POST /grading-feedback-task1` | JSON    |
| `POST /v1/ielts/writing/task2/grade` | `POST /grading-feedback-task2` | JSON    |

Writing question-generation routes are not part of the current gateway scope.
They must not be reintroduced through this grading contract without a separate
approved operation definition.

## 2. Authentication and trust boundaries

- AIHUB authenticates the public caller with its API key and user assertion.
- AIHUB sends the provider authentication token through the private downstream
  HTTP client. Clients never receive or choose that token or the provider host.
- Provider credentials, essays, assertions, and raw provider bodies must not be
  logged or returned in errors.

## 3. Request contract

AIHUB validates its public request before dispatch and maps it to the provider
request below. Unknown public fields are invalid.

### Task 1

Public fields:

| Field        | Type   | Required | Limits                                                                                          |
| ------------ | ------ | -------- | ----------------------------------------------------------------------------------------------- |
| `question`   | string | yes      | 1–2,000 characters                                                                              |
| `chart_type` | enum   | yes      | `Bar Chart`, `Line Graph`, `Pie Chart`, `Table`, `Map`, `Process Diagram`, or `Multiple Graphs` |
| `image_url`  | URI    | yes      | maximum 2,000 characters                                                                        |
| `essay`      | string | yes      | 1–20,000 characters                                                                             |
| `language`   | `vi`   | no       | Current downstream grading output is Vietnamese.                                                |

Provider mapping:

```json
{
  "question": "<question>",
  "topic": "<chart_type>",
  "essay": "<essay>",
  "url": "<image_url>"
}
```

### Task 2

Public fields:

| Field      | Type   | Required | Limits                                           |
| ---------- | ------ | -------- | ------------------------------------------------ |
| `question` | string | yes      | 1–2,000 characters                               |
| `topic`    | string | yes      | 1–200 characters                                 |
| `essay`    | string | yes      | 1–20,000 characters                              |
| `language` | `vi`   | no       | Current downstream grading output is Vietnamese. |

Provider mapping:

```json
{
  "question": "<question>",
  "topic": "<topic>",
  "essay": "<essay>"
}
```

The provider must not require fields that AIHUB does not send. A change to
request names, limits, or chart-type values is a contract change and requires
fixture/test updates.

## 4. Success response contract

Both provider grading operations return the same response shape:

```json
{
  "success": true,
  "data": {
    "task": "IELTS_WRITING_TASK_1_GRADING",
    "overall_band": 7.0,
    "evaluation": {
      "1_task_achievement": {
        "band_score": 7,
        "band_reason": "<reason>",
        "strengths": ["<strength>"],
        "areas_for_improvement": ["<improvement>"]
      },
      "2_coherence_cohesion": {},
      "3_lexical_resource": {},
      "4_grammatical_range_accuracy": {}
    },
    "Overall Assessment": {
      "Summary": "<summary>",
      "Specific Suggestions": ["<suggestion>"],
      "Next Steps": ["<next step>"]
    }
  }
}
```

The first evaluation key is `1_task_achievement` for Task 1 and
`1_task_response` for Task 2. The remaining three keys are stable:

- `2_coherence_cohesion`
- `3_lexical_resource`
- `4_grammatical_range_accuracy`

Every evaluation entry must contain a numeric `band_score` from 0 to 9 in
0.5 increments. `band_reason` is a string. `strengths` and
`areas_for_improvement` are arrays of strings; an empty array is the correct
representation when there is nothing to add.

`data_micro` may contain evidence comments used for annotations:

```json
{
  "data_micro": {
    "task_achievement": {
      "inaccurate_data_support": {
        "comments": [
          { "quote": "<essay quote>", "explanation": "<explanation>" }
        ]
      }
    }
  }
}
```

Issue keys are dynamic, but criterion keys must be one of the documented
criteria. `data_micro` is optional; malformed entries are ignored when they do
not contain a usable quote.

## 5. Private fields and redaction

The following must never become part of the public normalized response:

- `data.coT` and any chain-of-thought or internal reasoning;
- `evaluation.*.feedback_detail` when it contains provider-internal detail;
- provider-specific envelopes, raw essay copies, credentials, and assertions;
- unknown private fields that are not explicitly approved for normalization.

The provider should omit chain-of-thought from a production response whenever
possible. AIHUB drops it even when it appears in a captured provider fixture.

## 6. AIHUB normalized response

AIHUB returns the shared `{ data, meta }` envelope with this stable `data`
shape:

```json
{
  "overall_band": 7.0,
  "language": "vi",
  "criteria": [
    {
      "id": "task_achievement",
      "name": "Task Achievement",
      "band": 7,
      "band_reason": "<reason>",
      "strengths": ["<strength>"],
      "improvements": ["<improvement>"]
    }
  ],
  "summary": "<summary>",
  "suggestions": ["<suggestion>"],
  "next_steps": ["<next step>"],
  "annotations": [
    {
      "criterion": "task_achievement",
      "issue": "inaccurate_data_support",
      "quote": "<essay quote>",
      "explanation": "<explanation>"
    }
  ]
}
```

`criteria` contains exactly four entries in criterion order. The machine-
enforced public schema is `src/contracts/writing/grading.ts`; AIHUB treats a
malformed successful provider body as `AI_SERVICE_CONTRACT_VIOLATION` rather
than guessing or returning the raw body.

## 7. Error contract

The provider should return stable HTTP statuses and a machine-readable error
body. AIHUB maps the status to its shared error categories and does not expose
provider detail text:

| Status      | Meaning                                           |
| ----------- | ------------------------------------------------- |
| `400`       | Invalid request or unsupported grading input.     |
| `401`/`403` | Provider authentication or authorization failure. |
| `413`       | Request exceeds the configured body limit.        |
| `429`       | Provider throttling.                              |
| `5xx`       | Provider or model pipeline failure.               |

## 8. Compatibility and change control

- Additive private fields are safe only when they do not change existing field
  meaning or leak into the normalized response.
- Renaming/removing fields, changing types/ranges/nullability, changing the
  criterion keys, or changing error semantics requires a versioned review and
  a new captured fixture.
- AI Writing, AIHUB, and WISPACE must approve fixture and contract changes
  together. Update this document, the machine schema, adapter tests, and
  `test/fixtures/ai-writing/` in the same change.
