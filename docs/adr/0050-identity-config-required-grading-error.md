# ADR-0050: Report missing grading identity configuration as a policy error

- Status: Accepted
- Related issue: #156
- Related ADR: ADR-0049

When a valid API key is paired with a User Assertion but its Organization has no active identity configuration, AIHUB returns `403 IDENTITY_CONFIG_REQUIRED` with the same generic setup guidance for absent and disabled configurations. The API key has authenticated the Organization, so this is a missing Organization prerequisite rather than an invalid assertion; `401` remains for missing or invalid assertions, and configuration-store failures remain `503 IDENTITY_PROVIDER_UNAVAILABLE`. The response does not disclose whether configuration is absent or disabled, or include assertion, key, or configuration details.
