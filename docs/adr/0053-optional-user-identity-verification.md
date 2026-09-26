# ADR-0053: Make end-user identity verification optional per Organization

- Status: Accepted
- Supersedes: ADR-0050
- Related ADR: ADR-0049

New Organizations often want to grade before they can host a JWKS or sign JWTs, so user-scoped operations now take one `X-User-Identity` header whose form is chosen by the Organization's saved identity configuration, never by the shape of the value: an Organization with an active configuration must send a Signed User Assertion (verified exactly as before, and a plain value is rejected with `401 INVALID_USER_IDENTITY` rather than downgraded), while an Organization without one sends a Declared User ID that AIHUB accepts unsigned. The Organization is still authenticated by its API key, so a Declared User ID is trusted exactly as far as that key is; what is lost is protection against a key holder impersonating another end user inside the same Organization, which the integration guide states plainly.

## Considered Options

- **Separate `X-User-Id` header for the declared form.** Rejected: the team prefers one header for integrators; mode ambiguity is removed by deciding on configuration instead.
- **Keep `X-User-Assertion` and accept aliases.** Rejected: no production customers yet, so the header and the error codes (`USER_IDENTITY_REQUIRED`, `INVALID_USER_IDENTITY`) are renamed outright and `IDENTITY_CONFIG_REQUIRED` is removed.
- **Pseudonymise declared identifiers (HMAC) before storage.** Rejected for now: no compliance requirement, and it would stop Organizations reconciling usage per end user.
- **Forbid returning to the declared form once a configuration existed.** Rejected: disabling the configuration is an audited owner decision; it is the explicit way back.

## Consequences

- Disabling an identity configuration no longer blocks grading; it switches the Organization to Declared User IDs (fail-open by owner choice). JWKS fetch or configuration-store failures still return `503 IDENTITY_PROVIDER_UNAVAILABLE` and never fall back to the declared form.
- One End-User ID rule applies to both forms, including a Signed User Assertion's `sub`: 1–256 visible ASCII characters (0x21–0x7E), no whitespace. Email addresses pass and are stored in usage records and forwarded downstream as-is.
- Downstream `user_id`/`sub` shapes are unchanged, but they are signature-verified only for Organizations with an active configuration; the AI Speaking team must be told.
