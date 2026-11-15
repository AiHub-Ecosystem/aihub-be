# Legacy content backend fixtures

AIHUB captured these responses from `https://backend.aihubproduction.com` with
anonymous `GET` requests on 2026-11-14. There is no staging environment. The
captures back the public schemas in `src/contracts/` and the client specs in
`src/modules/content-proxy/`.

| File                              | Request                                           | HTTP |
| --------------------------------- | ------------------------------------------------- | ---: |
| `writing-template-task1.200.json` | `GET /api/WritingTemplate`, `X-Task-Type: task 1` |  200 |
| `writing-template-task2.200.json` | `GET /api/WritingTemplate`, `X-Task-Type: task 2` |  200 |
| `speaking-library.200.json`       | `GET /api/Speaking/library`                       |  200 |
| `listening-tests.200.json`        | `GET /v1/listening/tests`                         |  200 |
| `reading-tests.200.json`          | `GET /v1/reading/tests`                           |  200 |

The repository is public, so each Writing template's author was replaced after
capture: every `userName` value is `Template Author` and every `userId` value is
`1`. The field names and types are unchanged. The public response drops both
fields.

The captures are anonymous, so per-user counts such as `user_attempt_count`,
`done_count`, and `attemptCount` show the anonymous view.
