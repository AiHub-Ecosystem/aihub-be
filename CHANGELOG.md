# AIHUB Public API Changelog

This changelog tracks the public API contract version, independently of the
backend package version. `/v1` is the current supported major.

## [1.0.0] — `/v1` baseline

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
