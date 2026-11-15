# ADR-0163: Organization identity issuer control and release

- Status: Accepted
- Date: 2026-11-15
- Amends: [ADR-0004](0004-signed-user-assertions-jwks.md), [ADR-0049](0049-owner-managed-organization-identity-configuration.md), [ADR-0055](0055-owner-only-organization-identity-configuration-read.md)
- Related: [#445](https://github.com/AiHub-Ecosystem/aihub-be/issues/445)

## Context

Self-serve Organization owners can create their own organizations, but could claim any issuer with inline public keys. The global unique issuer index let a new tenant squat on an existing customer's issuer. Disabling the configuration did not release it, and the conflict response named another Organization as the reason.

## Decision

- A self-service JWKS URL is accepted only when its origin (scheme, hostname, and port) equals the issuer URL origin. Existing SSRF protections still validate and fetch the URL.
- Inline JWKS are operator-provisioned through `identity:set`, which is the explicit operator-approval path. Self-service PUT refuses inline keys until a proof-of-control challenge is designed.
- A uniqueness conflict uses the already-published `ORGANIZATION_IDENTITY_ISSUER_CONFLICT` code and a generic message that does not identify another Organization.
- `identity:release --org <id> --actor <username>` disables the Organization Identity Configuration, releases its unique issuer claim, increments the JWKS cache version, and records `organization.identity_issuer_released` in the same transaction. The configuration row and audit record remain durable.
- A database trigger reclaims the issuer when a configuration's trust settings change or a disabled configuration is re-enabled. This also protects claims when an N-1 writer, which does not know the claim column, changes the configuration.

## Consequences

Self-service customers using inline keys must use operator provisioning. Releasing an issuer disables Signed User Assertion verification for that Organization. Existing Declared User ID behavior applies until it configures a new issuer. The release command requires an active operator account and the existing operator database-target confirmation.
