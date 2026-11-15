# Legacy content backend fixtures

AIHUB captured these responses from `https://backend.aihubproduction.com` with
anonymous `GET` requests on 2026-11-14. There is no staging environment. The
captures back the public schemas in `src/contracts/` and the client specs in
`src/modules/content-proxy/`.

The files hold the legacy backend's own bodies. AIHUB does not serve these
paths: it serves the five `/v2/ielts/...` routes of ADR-0167 and maps the
upstream body to snake_case schemas.

| File                              | Upstream request                                  | AIHUB route                             |
| --------------------------------- | ------------------------------------------------- | --------------------------------------- |
| `writing-template-task1.200.json` | `GET /api/WritingTemplate`, `X-Task-Type: task 1` | `GET /v2/ielts/writing/task1/templates` |
| `writing-template-task2.200.json` | `GET /api/WritingTemplate`, `X-Task-Type: task 2` | `GET /v2/ielts/writing/task2/templates` |
| `speaking-library.200.json`       | `GET /api/Speaking/library?page=<n>&pageSize=<n>` | `GET /v2/ielts/speaking/library`        |
| `listening-tests.200.json`        | `GET /v1/listening/tests?page=<n>&pageSize=<n>`   | `GET /v2/ielts/listening/tests`         |
| `reading-tests.200.json`          | `GET /v1/reading/tests?page=<n>&pageSize=<n>`     | `GET /v2/ielts/reading/tests`           |

Every capture returned HTTP 200. The legacy backend honours only `page` and
`pageSize`, and caps `pageSize` at 200 on reading. It returns the whole Writing
list unpaginated, so AIHUB slices Writing in memory and forwards the page window
for the other three.

The repository is public, so each Writing template's author was replaced after
capture: every `userName` value is `Template Author` and every `userId` value is
`1`. The field names and types are unchanged. The public response drops both
fields.

The captures are anonymous, so per-user counts such as `user_attempt_count`,
`done_count`, and `attemptCount` show the anonymous view. The public response
drops the per-user counts.
