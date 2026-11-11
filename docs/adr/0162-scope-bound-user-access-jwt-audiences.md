# ADR-0162: Scope-bound User Access JWT audiences

- Status: Accepted
- Date: 2026-11-11
- Amends: [ADR-0022](0022-aihub-local-user-authentication.md) — the fixed User Access JWT audience
- Related: [#352](https://github.com/AiHub-Ecosystem/aihub-be/issues/352)

## Context

Production and Sandbox use the same configured User Access JWT issuer and signing key. Their verifier also accepts the same fixed audience, `aihub-user-api`, so a token signed in one scope passes cryptographic and claim validation in the other. The account lookup currently limits the impact only when the token subject is absent from the receiving database; a copied database or reused account ID removes that incidental barrier.

## Decision

- Set the User Access JWT audience to `aihub-user-api:<AIHUB_RUNTIME_DATABASE_SCOPE>`. The supported runtime scopes are `production` and `sandbox`.
- Use the same scope-derived audience for issuance and verification. Keep the configured issuer, signing key, claims, 900-second maximum lifetime, and 60-second clock skew unchanged.
- Do not accept the former unscoped audience as a compatibility fallback. It does not identify which scope issued the token.
- After a scope is deployed with this rule, access tokens issued before the change with the former audience are rejected immediately, even if their original expiry is later. Their original lifetime is at most 15 minutes; login, refresh, and Web Session exchange mint a new token with the deployed scope's audience.

## Consequences

Production and Sandbox reject each other's User Access JWTs even when both scopes share signing material and an account exists in both databases. A deployment invalidates still-live tokens minted with the former audience, so clients may need to refresh or sign in again; there is no grace period that would keep the cross-scope gap open.
