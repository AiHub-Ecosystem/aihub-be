# ADR-0049: Owner-managed Organization identity configuration

- Status: Accepted
- Related issue: #157
- Related ADR: ADR-0035

Only an active `owner` of an active Organization may create or replace its User Assertion identity configuration through the Bearer boundary. Authenticated callers who do not meet that policy receive the existing Safe Authorization Denial; missing or invalid Bearer credentials follow the existing authentication errors. The request must provide exactly one non-null JWKS source (`jwks_url` or `public_keys_jwks`), matching the Customer Web's two setup options and avoiding stored keys that the verifier would ignore when a URL is present. A new configuration is active, while replacement preserves its current status so an owner cannot override an operator's disablement; a supplied URL is validated on save through the existing SSRF-protected JWKS fetch path.

The configuration and its Organization Audit Event commit together, and the event records only the issuer and key source. The API returns success only after the Organization's JWKS cache entry is purged. If purge fails after the durable write, the request returns a retryable failure; retrying the identical request retries the purge without updating the configuration or writing a duplicate audit event, following ADR-0035's state-idempotent repeat rule.
