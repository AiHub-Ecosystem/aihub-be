# AI Speaking fixtures

## v2.4 provider captures

AI Speaking supplied the original response captures from controlled Production
probes on 2026-10-31. AIHUB captured the additional complete-exam fixtures in
controlled Production probes on 2026-11-02 (#1478). There is no staging
environment. The original success flow submitted two Part 1 questions,
aggregated their Part, aggregated a test result, and read back the question,
Part, and test results; it did not represent a complete three-Part IELTS test.

| File                                       | Operation / result                                                       | HTTP |
| ------------------------------------------ | ------------------------------------------------------------------------ | ---: |
| `grading-v2-question-post.200.json`        | `POST /api/v2/speaking/questions/grading`, first question                |  200 |
| `grading-v2-question-post-second.200.json` | Same operation, second question in the Part                              |  200 |
| `grading-v2-question-get.200.json`         | `GET /api/v2/speaking/responses/{response_id}`                           |  200 |
| `grading-v2-part-post.200.json`            | `POST /api/v2/speaking/parts/grading`                                    |  200 |
| `grading-v2-part-get.200.json`             | `GET /api/v2/speaking/parts/{part_result_id}`                            |  200 |
| `grading-v2-test-post.200.json`            | `POST /api/v2/speaking/tests/grading`                                    |  200 |
| `grading-v2-test-get.200.json`             | `GET /api/v2/speaking/tests/{test_id}`                                   |  200 |
| `grading-v2-audio-unreadable.422.json`     | Question grading with unreadable short audio                             |  422 |
| `grading-v2-invalid-header.400.json`       | Invalid Organization ID header                                           |  400 |
| `grading-v2-missing-header.400.json`       | Missing User ID header                                                   |  400 |
| `grading-v2-not-found.404.json`            | Read for an unknown response ID                                          |  404 |
| `grading-v2-other-user.404.json`           | Read a response owned by another User                                    |  404 |
| `grading-v2-wrong-secret.401.json`         | Invalid service secret                                                   |  401 |
| `grading-v2-validation-post.400.json`      | Earlier probe: invalid `part`                                            |  400 |
| `grading-v2-exam-question-p1-a.200.json`   | Exam: Part 1 question 1                                                  |  200 |
| `grading-v2-exam-question-p1-b.200.json`   | Exam: Part 1 question 2                                                  |  200 |
| `grading-v2-exam-part1.200.json`           | Exam: Part 1 aggregation                                                 |  200 |
| `grading-v2-exam-question-p2.200.json`     | Exam: Part 2 question                                                    |  200 |
| `grading-v2-exam-part2.200.json`           | Exam: Part 2 aggregation                                                 |  200 |
| `grading-v2-exam-question-p3-a.200.json`   | Exam: Part 3 question 1                                                  |  200 |
| `grading-v2-exam-question-p3-b.200.json`   | Exam: Part 3 question 2                                                  |  200 |
| `grading-v2-exam-part3.200.json`           | Exam: Part 3 aggregation                                                 |  200 |
| `grading-v2-exam-test-post.200.json`       | Exam: Test aggregation of Parts 1 to 3                                   |  200 |
| `grading-v2-exam-test-get.200.json`        | Exam: Test read-back                                                     |  200 |
| `grading-v2-part-count-mismatch.200.json`  | Part aggregation with a wrong `expected_question_count`                  |  200 |
| `grading-v2-test-mixed-tests.422.json`     | Test aggregation whose questions used another `test_code`: `mixed_tests` |  422 |
| `grading-v2-test-part-not-found.404.json`  | Test aggregation naming an unknown Part: `part_not_found`                |  404 |

The `grading-v2-exam-*` files are one complete three-Part exam captured on
2026-11-02 (#1478): five graded questions, three Part aggregations and the Test
aggregation, with synthetic speech and identity and `test_type` sent as
`Full-test`. A first run used a question `test_code` different from the Test
aggregation's `test_id` and received `422 mixed_tests`; a second run used the
same value and received 200. The provider later confirmed the exact rules in
[#1450](https://github.com/AiHub-Ecosystem/aihub-be/issues/1450#issuecomment-6608652752):
Test aggregation requires each stored question `test_id` to be null or equal to
the request `test_id`, while Part aggregation compares only the distinct
non-null stored values within that Part. The provider also answered 200, with
the stored question count, to a mismatched `expected_question_count`, and
accepted `full_test` as well as `Full-test` on a Part aggregation.

The provider's v2.4 request and tenant contract, including the required
`X-AIHUB-*` headers, is summarized in
[`ai-speaking-grading-v2.4.md`](../../../docs/contracts/ai-services/ai-speaking-grading-v2.4.md).
The captures are evidence of provider behavior, not an approved AIHUB public
`/v2` response baseline. The provider's 2026-10-31 release accepts AIHUB's
`org_...` Organization IDs directly; cross-Organization isolation still needs
its separate evidence under #1456. A `429 rate_limited` response was not
captured.

Every non-allowlisted string was replaced with `[redacted]`; only the root
`status`, `error.code`, and `data.meta.schema_version`, `result_type`, and
`test_type` values are retained. Keys, types, array lengths, nulls, and numeric
values are preserved. The fixture scrub spec checks these files for unredacted
Vietnamese text and transcript-like values.

`grading.response.json` is the approved v1 success capture. The v1 failure
captures below come from #247. Each file name ends with the HTTP status the
provider returned.

| File                             | Status | Input                                                                  | What the provider returned                                                                                          |
| -------------------------------- | ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `grading-no-speech.200.json`     | 200    | 5 s of 16 kHz mono WAV white noise; 3 s of silence gave the same shape | A normal success body with `scorability.is_scorable: false` and every band at 0, not an error                       |
| `grading-convert-audio.500.json` | 500    | About 9 KB of ASCII text uploaded as `answer.wav`                      | `{"detail": "Grading pipeline failed: [error_convert_audio] ..."}`                                                  |
| `grading-empty-audio.400.json`   | 400    | A 0-byte `answer.wav`                                                  | `{"detail": "Uploaded audio file is empty or corrupted ..."}`. AIHUB refuses audio under 100 bytes before dispatch. |

The v1 provider's captured error bodies are FastAPI's `{"detail": string}`.
They are not the `ErrorResponse` (`{code, message}`) schema that its OpenAPI
document declares. The failure marker appears only inside `detail`.

In the 2026-10-01 and 2026-10-02 incidents, the provider logged
`[error_no_speech]` and AIHUB answered 502. That could not be reproduced on
2026-10-19: silence, white noise, and faint noise all returned the 200
non-scorable body above, so the provider now grades a recording without speech
instead of failing it.

## How the v1 captures were made

On 2026-10-19 a short Node script ran inside the AIHUB Production app container
and posted multipart requests straight to AI Speaking's
`POST /api/v1/speaking/grading`. It used the same base URL, the
`x-client-id`/`x-secret-key` credentials from the rendered runtime secret
bundle, and the same form fields as AIHUB's adapter:

- `user_id=aihub-capture-247`
- `part=1`
- `question_id=p1_hometown`
- `test_type=Practice`

All audio was generated by the script, so no candidate content was used. The
v1 capture scrub spec fails if any `grading*.json` contains Vietnamese text or
an unredacted transcript field.
