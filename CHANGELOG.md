# AIHUB Public API Changelog

This changelog tracks the public API contract version, independently of the
backend package version. `/v1` is the current supported major.
Version headings use the date the release shipped. Record each newly added
public error code and value for an open response enum by name, as a code span
such as `` `PRECONDITION_FAILED` ``, under `Added` in the dated entry that
introduced it. `pnpm check:api-compatibility` refuses a release that leaves one
out.

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
