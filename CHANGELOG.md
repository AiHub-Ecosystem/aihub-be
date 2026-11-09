# AIHUB Public API Changelog

This changelog tracks the public API contract version, independently of the
backend package version. `/v2` is the newest supported major; `/v1` stays
supported until its sunset.
Version headings use the date the release shipped. Record each newly added
public error code and value for an open response enum by name, as a code span
such as `` `PRECONDITION_FAILED` ``, under `Added` in the dated entry that
introduced it. `pnpm check:api-compatibility` refuses a release that leaves one
out.

## [2.6.0] - 2026-11-08

### Added

- `POST /v2/ielts/speaking/grading-jobs` accepts an existing Speaking Audio
  asset and returns a durable job ID; `GET /v2/ielts/speaking/grading-jobs/{job_id}`
  returns its state and terminal result or safe error. Submit accepts an optional
  `Idempotency-Key`; both routes require `speaking.grade` and are `no-store`.

## [2.5.0] - 2026-11-02

### Added

- `/v2/ielts/writing/micro-exercises`,
  `/v2/ielts/writing/long-writing-exercises`, and
  `/v2/ielts/writing/micro-exercises/grade` use the `writing.exercise` scope.
  Exercise error codes are provider-owned informational strings, so clients
  must tolerate new and renamed values. Writing chart uploads also accept the
  `writing.exercise` scope.

## [2.4.0] - 2026-11-01

### Changed

- Speaking `/v2` stored-result GETs and Part/Test aggregation inputs now require
  result IDs previously recorded for the same Organization, exact End-User ID,
  and environment. Unrecorded pre-release results return `404 NOT_FOUND`.

### Added

- `POST /v2/ielts/writing/task1/grade` and `POST /v2/ielts/writing/task2/grade`
  grade Writing on the AI Writing service's v3 pipeline. The request body is the
  `/v1` body; an essay of more than 1,000 words is refused with
  `400 INVALID_REQUEST`. The response is a new shape: `overall_band`, four
  `criteria` entries with their own `errors` and `suggestions`,
  `overall_assessment` (`summary` and `progress`) and `data_micro`. The AIHUB
  budget for these routes is 125 seconds (ADR-0143). `/v1` Writing is unchanged.
- The Writing routes' error responses document these existing codes, which no earlier
  `/v2` route documented: `IDEMPOTENCY_CONFLICT`,
  `AUTH_IDENTITY_UNAVAILABLE`, `AUTH_MFA_ALREADY_ENABLED`,
  `ORGANIZATION_MEMBER_EXISTS`, `ORGANIZATION_OWNER_REQUIRED`,
  `ORGANIZATION_IDENTITY_ISSUER_CONFLICT`, `ORGANIZATION_CREATION_LIMIT_REACHED`
  and `AVATAR_CHANGED`. These codes already exist on `/v1`; no new error code
  was created.

## [2.3.0] - 2026-11-01

### Changed

- `/v2` question results: in `data.criteria.*.diagnostics[]`, `error_codes`,
  `explain_vi`, `improvement` and `improvement_vi` may be `null` for a finding
  the language check could not classify. A real recording returned a `null`
  `error_codes`, which contract 2.2.0 refused with
  `502 AI_SERVICE_CONTRACT_VIOLATION`. Same defect class and acceptance as
  2.1.0 (ADR-0142).

## [2.2.0] - 2026-11-01

### Changed

- `/v2` Part and Test results: `data.meta.total_speaking_seconds` is `null`
  when the graded recordings held no speech. Contract 2.1.0 required a number
  and answered `502 AI_SERVICE_CONTRACT_VIOLATION` for that input. Same defect
  class and same acceptance as 2.1.0 (ADR-0142).

## [2.1.0] - 2026-11-01

### Changed

- `/v2` Speaking results now allow `null` where the AI service has no value.
  `data.meta.test_id` is `null` when the request did not name a test, and on a
  question result `data.meta.part_result_id` is `null` when it did not name a
  Part. On a question result, `data.transcript.stats.word_count` and
  `speaking_seconds` are `null` for a recording without speech. The 2.0.0
  contract required a value and answered `502 AI_SERVICE_CONTRACT_VIOLATION`
  for these requests, so no response was ever returned for them. This widens
  the 2.0.0 response types as a defect fix, accepted by the owner in ADR-0142
  because 2.0.0 was live for under a day with no known consumer.

## [2.0.0] - 2026-11-01

### Added

- `/v2` Speaking: `POST /v2/ielts/speaking/questions/grade`,
  `POST /v2/ielts/speaking/parts/grade`, `POST /v2/ielts/speaking/tests/grade`,
  and `GET` routes that read a stored question, Part, or Test result back.
  A `429` from the AI service now carries `Retry-After` on `/v1` and `/v2`.

### Migration

- Move Speaking grading and result retrieval from `/v1` to `/v2`. `/v1` remains
  available alongside `/v2` and now carries its `Deprecation` and `Sunset`
  headers; Writing and `ielts/speaking/grading-json` remain on `/v1`. The `/v2`
  response is the AI Speaking v2.4 result: it has no `scorability`, `relevance`,
  `pause_count`, `duration_seconds`, `grammar_errors`, `vocabulary_upgrades`,
  `strong_point_vi` or `action_plan_vi`, and `test_type` is `practice` or
  `full_test`.

## [1.11.0] - 2026-11-09

### Changed

- `/v1/organizations/{organization_id}/api-keys` create now requires
  `allowed_environments` in the request body. The environment a credential is
  bound to is part of its authority, so the caller states it instead of
  receiving a Production default (ADR-0159).

### Added

- `/v1/organizations/{organization_id}/api-keys` responses carry `created_by`
  and `last_rotated_by`, the immutable usernames of the account that created
  the key and of its last rotator. Either is `null` when nobody is recorded,
  and the list reports unknown rather than naming an account.
- Disabling a member or demoting them now returns `handled_api_keys` in the
  mutation response: the active API keys they created or last rotated, so the
  caller reviews or revokes them without a separate lookup. The field is
  absent when the mutation removed no authority.

## [1.10.0] - 2026-11-08

### Added

- `POST /v1/me/avatar/uploads` (Avatar presigned upload creation) now declares `429`. Avatar presigning is bounded per account (ADR-0068
  update): an account may hold 3 open, unconsumed, unexpired upload URLs and
  be issued 10 per rolling hour; a refusal answers `429 RATE_LIMITED`.

## [1.7.0] - 2026-11-02

### Changed

- Writing chart upload routes also accept `writing.exercise` API keys so
  exercise requests can use the existing authenticated chart upload flow.
  `writing.grade` remains supported.

## [1.9.0] - 2026-11-08

### Added

- Cross-site BFF forwarding for the refresh-cookie flow (ADR-0157). When a
  request to `POST /v1/auth/login`, `POST /v1/auth/refresh`, or
  `POST /v1/auth/logout` carries the Customer Web BFF client secret, the route
  requires a CSRF token in `X-AIHUB-CSRF-Token` and the end user's address in
  `X-AIHUB-End-User-IP`; a forwarded login and refresh return a
  `data.csrf_token` bound to the refresh session, and refresh rotation issues a
  new one. A forwarded refresh without a valid token is refused with
  `401 AUTH_REFRESH_TOKEN_INVALID` while the cookie is preserved. Requests
  without the client secret keep the same-site browser contract byte for byte.

## [1.8.1] - 2026-11-07

### Changed

- `/v1` Speaking `grading-json` accepts only the caller's organization-scoped
  audio asset, configured catalog sample objects under `speaking-samples/`, or
  the stable public sample answer URL. Other storage paths are refused with
  `400 INVALID_REQUEST` before dispatch.

## [1.8.0] - 2026-11-05

### Added

- `POST /v1/auth/user-access-tokens/revoke` lets an authenticated user revoke
  one of their User Access JWTs before expiry.

## [1.5.0] - 2026-10-30

### Changed

- The three Speaking audio upload routes (`POST /v1/speaking/audio/uploads` and
  its `refresh` and `complete` steps) now enforce the `speaking.grade` API-key
  scope, and the three Writing chart upload routes
  (`POST /v1/ielts/writing/task1/chart-uploads` and its `refresh` and `complete`
  steps) enforce `writing.grade`. A key without the scope now gets
  `403 FORBIDDEN` on these routes; they accepted any key before. The
  OpenAPI document marks each route with `x-required-scope`, as it does for the
  grading routes.

## [1.6.0] - 2026-11-02

### Added

- `GET /v1/organizations/{organization_id}/audit-events` now returns
  `actor_source` on each event: `authenticated_user`,
  `self_declared_operator`, or `legacy_unknown` for records written before
  actor provenance was recorded.

## [1.4.0] - 2026-10-30

### Changed

- The Organization roster (`GET /v1/organizations/me/members`) now returns pages
  of up to 100 Organizations, ordered by `organization_id`, with a required
  `data.next_cursor` (a string, or `null` on the last page). It accepts optional
  `limit` (1 to 100, default 100) and `cursor` query parameters. A caller with
  fewer than 100 Organizations still gets everything in one response. The
  endpoint now rejects any other query parameter with `400 INVALID_REQUEST`; it
  ignored them before.
- Each Organization in the roster lists its first 100 active members by
  username, as `members`. A new required `member_count` gives the number of
  active members, so a client can tell when the list is cut. The remaining
  members are paginated by `GET /v1/organizations/{organization_id}/members`,
  which owners and admins can read. See
  [#896](https://github.com/AiHub-Ecosystem/aihub-be/issues/896).

## [1.3.0] - 2026-10-30

### Added

- `PUT /v1/organizations/{organization_id}/identity-config` accepts an optional
  `If-Match` header, or `If-None-Match: *`, so a write based on an older read
  is refused instead of replacing a newer configuration. `GET` and `PUT` of
  the identity configuration return a strong `ETag` response header. A request
  without either header behaves as before. See the Integration Guide and
  [#579](https://github.com/AiHub-Ecosystem/aihub-be/issues/579).
- `PRECONDITION_FAILED` (`412`): the stored identity configuration no longer
  matches the `If-Match` or `If-None-Match` the write sent. Nothing was changed.
  It is not retryable; read the configuration again and resend. A malformed
  precondition header answers `400 INVALID_REQUEST`.

## [1.2.0] - 2026-10-30

### Changed

- The Organization membership list (`GET /v1/organizations/{organization_id}/members`)
  and open invitation list (`GET /v1/organizations/{organization_id}/invitations`)
  now return pages of up to 100 rows by default (maximum 500) with
  `data.next_cursor`. Both endpoints accept optional `limit` and `cursor` query
  parameters. See [#276](https://github.com/AiHub-Ecosystem/aihub-be/issues/276).

## [1.1.4] - 2026-10-29

### Changed

- An AI Service answer that rejects AIHUB's own request (HTTP 401 or 403) is
  returned as `503 AI_SERVICE_UNAVAILABLE` with `retryable: true`. It was
  `502 AI_SERVICE_ERROR` with `retryable: false`, which read as a problem with
  your request. An idempotency key used on such a request can be retried once
  the service recovers.
- An AI Service answer asking AIHUB to repeat the request (HTTP 408 or 425) is
  returned as `502 AI_SERVICE_ERROR` with `retryable: true`. It was
  `retryable: false`. No error code is added. See
  [#845](https://github.com/AiHub-Ecosystem/aihub-be/issues/845).

## [1.1.3] - 2026-10-29

### Changed

- The Writing grading fields `question`, `topic`, and `essay` state that their
  `maxLength` counts UTF-16 code units, not code points as a JSON Schema
  validator does by default. A character outside the Basic Multilingual Plane,
  such as most emoji, counts as 2. AIHUB's behavior is unchanged. The
  Integration Guide lists the limits. See
  [#847](https://github.com/AiHub-Ecosystem/aihub-be/issues/847).

## [1.1.2] - 2026-10-29

### Added

- `POST /v1/auth/mfa/enrollment/confirm` documents the `503` answer
  (`AUTH_WEB_SESSION_UNAVAILABLE`) it already returned when the Customer Web
  client secret is not provisioned or the forwarded end-user IP is missing. See
  [#934](https://github.com/AiHub-Ecosystem/aihub-be/issues/934).

## [1.1.1] - 2026-10-29

### Added

- `API_VERSION_RETIRED` (`410 Gone`): the answer to every request under a
  Public API major after the release that retires it. `error.details` names
  `retired_major`, `successor_major`, and `successor_docs`, and a
  `Link: <...>; rel="successor-version"` header points at the successor's
  documentation. No supported major returns it, so no operation in
  `openapi/v1.json` lists it. See [#1367](https://github.com/AiHub-Ecosystem/aihub-be/issues/1367).
- When a major has a published sunset, every response from a route under it,
  AI dispatch routes included, carries the `Deprecation`, `Sunset`, and
  `Link: rel="successor-version"` headers. A route with its own earlier sunset
  keeps it.

## [1.1.0] - 2026-10-27

### Added

- Responses that must not be cached document `Cache-Control: no-store` as a
  response header.

## [1.0.0] - 2026-10-27 — `/v1` baseline

This baseline records the current customer-facing contract, including behavior
that changed before public contract versioning was introduced.

### Changed

- Registration and organization invitation creation return `201 Created` with
  `email_delivery_status: "queued"` after AIHUB durably accepts the email
  request. A temporary email-provider failure no longer turns accepted
  registration or invitation work into a request failure. See [#252](https://github.com/AiHub-Ecosystem/aihub-be/issues/252) and [#290](https://github.com/AiHub-Ecosystem/aihub-be/issues/290).

### Compatibility

- Response object schemas allow unknown properties; clients must ignore fields
  they do not recognize. Request body schemas remain closed.
- AIHUB may add response headers and clients must ignore headers they do not
  recognize. `error.code` and Organization Audit event `action` are open
  response enums; clients must handle values they do not recognize.
