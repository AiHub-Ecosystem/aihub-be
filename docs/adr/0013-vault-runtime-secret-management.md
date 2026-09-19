# ADR-0013: Future Vault-backed runtime secret management

- Status: Accepted for future implementation; deferred during Stage A
- Date: 2026-09-12
- Related issue: [#30](https://github.com/lengocanh2005it/aihub-be/issues/30)

## Context

AIHUB needs a durable and auditable source for runtime credentials used by
downstream AI services and future object storage. The current Stage A
architecture intentionally keeps deployment secrets in a permissions-restricted
`.env` file and defers the production Vault cutover until the documented exit
triggers are met. The repository now has a typed runtime-secret provider and
Agent-file adapter, but it does not perform AppRole login or a production
cutover.

The terms used here are deliberate:

- A **runtime secret** is a credential needed by a running service, not an API
  key hash or User Assertion.
- A **machine identity** is the service identity used to access infrastructure
  such as Vault, not an end-user identity.
- The **secret source of truth** is Vault for runtime secret values; Postgres
  remains the durable source of truth for control-plane data such as API-key
  hashes.

## Decision

When the Vault adoption trigger is met, implement the following boundary:

1. **Scope:** move AI Speaking credentials, AI Writing credentials, SeaweedFS
   credentials, the Resend email-provider API key, and the User Access JWT
   signing key bundle first. Database and Redis credentials remain a later
   decision. API-key hashes, local-auth identity records, password hashes,
   verification-token hashes, and other control-plane records stay in Postgres.
2. **Storage:** use the existing KV v2 mount with these paths:

   ```text
   secret/aihub/{environment}/ai-speaking
   secret/aihub/{environment}/ai-writing
   secret/aihub/{environment}/seaweedfs
   secret/aihub/{environment}/resend
   secret/aihub/{environment}/user-access-jwt
   ```

   Use flat, stable keys for credentials. Provider URLs, bucket names, and
   regions are ordinary configuration unless they become sensitive in a
   deployment.

3. **Production machine identity:** use Vault Agent auto-auth with AppRole.
   AppRole material is provisioned out-of-band; the application must never
   use the current root token or a non-expiring root-derived token. Vault Agent
   renders the values locally, and AIHUB consumes them behind a server-side
   secret-provider boundary.
4. **Policy:** the current single AIHUB runtime receives one policy per
   environment with exact read-only access to its required service paths. It
   has no write, delete, broad-list, `sys`, or auth-management permissions.
5. **Rotation:** V1 reads secrets at startup. Credential rotation uses an
   overlap window and rolling restart; hot reload is deliberately deferred.
6. **Failure behavior:** after startup, the process may continue using the
   values already held in memory. A new startup fails closed when Vault or a
   required secret is unavailable. Dev may use an explicit local fallback;
   Dev/Production must not silently fall back to `.env`.
7. **Local development:** use a dedicated limited-scope, expiring token (or a
   local Agent), never root. Any local `.env` fallback must be explicit and
   development-only.
8. **Verification:** unit and integration tests use a mocked provider in CI.
   A real Vault smoke test is manual and opt-in; it never runs against the VPS
   by default.

## Consequences

- No Vault SDK or direct AppRole login is introduced; the repository contains
  only the provider seam, Agent templates, policies, and operational runbook.
- Startup and rolling-restart procedures become part of the operational runbook
  when issue #30 is scheduled.
- A running process is resilient to a temporary Vault outage, but a restarted
  process cannot start without its required secrets.
- The current Stage A `.env` decision remains valid until its documented Vault
  adoption trigger is met.

## Temporary Stage A operating exception

Until the Vault adoption trigger is met, production may use the explicit
`docker-compose.production.env.yml` override with
`AIHUB_ALLOW_PRODUCTION_ENV_SECRETS=true`. The deployment `.env.production`
file remains outside Git, is mode `600`, and is never copied into CI output or
logs. The override is removed during the issue #30 Vault cutover, followed by
rotation and removal of the long-lived downstream credentials.

## Rejected alternatives

- Direct AppRole login and renewal inside NestJS, which expands application
  responsibility for machine identity and token lifecycle.
- Manually provisioned periodic/root-derived tokens.
- Hot reload and production `.env` fallback in the first implementation.
