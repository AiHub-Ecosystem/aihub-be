# AIHUB Public API Changelog

This changelog tracks the public API contract version, independently of the
backend package version. `/v1` is the current supported major.
Version headings use the date the release shipped. Record each newly added
public error code and value for an open response enum by name under `Added` in
the dated entry that introduced it.

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
