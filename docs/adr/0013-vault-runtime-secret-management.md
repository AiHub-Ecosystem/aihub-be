# ADR-0013: Vault-backed runtime secret management

- Status: Accepted and implemented
- Date: 2026-09-12; production cutover 2026-09-20
- Related issue: [#30](https://github.com/AiHub-Ecosystem/aihub-be/issues/30)

## Context

AIHUB previously supplied long-lived provider, signing, database, and Redis
credentials through a mode-600 `.env.production` file. That file remains useful
for ordinary deployment configuration, but runtime credentials need a durable,
auditable source with least-privilege access and explicit rotation.

## Decision

1. Vault KV v2 is the source of truth for runtime credentials. The paths are:

   ```text
   secret/aihub/{environment}/ai-speaking
   secret/aihub/{environment}/ai-writing
   secret/aihub/{environment}/seaweedfs
   secret/aihub/{environment}/resend
   secret/aihub/{environment}/user-access-jwt
   secret/aihub/{environment}/database
   secret/aihub/{environment}/redis
   secret/aihub/{environment}/sandbox-assertion
   ```

2. Vault Agent uses AppRole auto-auth and renders two local snapshots: the
   typed downstream runtime-secret document and the process connection document.
   The NestJS application never performs AppRole login or handles a root token.
3. The runtime identity has exact read-only access to those environment paths;
   it cannot write, delete, list broadly, administer auth, or access `sys`.
4. The typed provider loads downstream credentials once at startup. The process
   bootstrap loads the selected production/sandbox database and Redis URLs before
   module wiring. Existing public API, downstream adapters, and control-plane
   Postgres data remain unchanged.
5. Development/test may use an explicit environment source. Production and
   staging fail closed when Agent material is missing or malformed.
6. Rotation is overlap plus rolling restart. Hot reload, per-request Vault reads,
   and automatic rotation orchestration are not part of this implementation.

## Consequences

- Provider, signing, database, and Redis credential values are no longer stored
  in `.env.production`.
- Vault Agent snapshots are still local files, protected by UID/GID `10001`,
  mode `0600`, and a mode-`0700` directory; this is file delivery, not an
  in-memory-only secret channel.
- A running process continues using its validated snapshot through a temporary
  Vault outage. A restart fails closed until Agent renders both files.
- The one-use AppRole Secret ID must be rotated when the Agent container is
  recreated after its initial login.
- Public contracts, API-key hashes, identity configuration, usage, idempotency,
  and Redis cache semantics are unchanged.

## Rollback

Rollback restores the previous approved Vault KV versions, restarts Vault Agent
and the application gradually, and verifies health plus one safe downstream
request. It does not reintroduce a production environment-secret override.
