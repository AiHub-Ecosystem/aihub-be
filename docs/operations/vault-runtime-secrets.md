# Vault-backed runtime secrets

This runbook describes the future cutover from deployment environment
credentials to Vault Agent-rendered runtime secrets. The current Stage A local
development path remains an explicit `.env` source until the adoption trigger
is met.

## Source selection

AIHUB supports two sources:

- `AIHUB_RUNTIME_SECRET_SOURCE=env` — development/test by default. A temporary
  production exception is available only through the tracked Stage A Compose
  override with `AIHUB_ALLOW_PRODUCTION_ENV_SECRETS=true` and a mode-600
  deployment `.env.production` file.
- `AIHUB_RUNTIME_SECRET_SOURCE=agent-file` plus
  `AIHUB_RUNTIME_SECRETS_FILE=<agent-rendered JSON path>` — the Dev/Staging/
  Production path. The application reads the file once during startup.

Production and Dev must never silently fall back from an Agent file to `.env`;
the temporary production exception is explicit and tracked by issue #30.
If a required bundle is missing or malformed, startup fails closed. A process
that has already loaded a valid snapshot continues using that in-memory
snapshot during a temporary Vault/Agent outage; it does not read Vault per
request.

## Migration sequence

1. Confirm the Vault adoption trigger and identify the exact deployment
   environment.
2. Apply the matching policy from `ops/vault/policies/` using an operator
   session. Do not use the AIHUB machine identity for policy administration.
3. Create the KV v2 bundles with the required keys. Keep values out of source,
   issues, fixtures, CI output, and chat transcripts.
4. Provision the environment AppRole and configure Vault Agent to render the
   template under the AIHUB service account.
5. Set `AIHUB_RUNTIME_SECRET_SOURCE=agent-file` and the rendered-file path in
   the deployment secret/config channel.
6. Start one instance and run the opt-in smoke test with the AppRole-authenticated
   non-root identity. Verify health, Speaking/Writing dispatch, and redacted
   logs before rolling the change across the deployment.
7. After the rolling restart is healthy, remove the migrated long-lived
   downstream credentials from Dev/Production deployment environments.

## Rotation and rollback

Runtime rotation is startup-only in V1:

1. Write the replacement downstream credential in the appropriate KV v2
   version while the existing credential remains valid.
2. Confirm the Agent renders the new snapshot without printing it.
3. Roll instances gradually and verify health plus a safe downstream smoke
   request after each batch.
4. Retire the old downstream credential only after all instances are healthy.

Rollback uses the previous approved KV version and another rolling restart. The
cutover switch is the `AIHUB_RUNTIME_SECRETS_FILE` deployment setting: point it
at the Agent-rendered snapshot for the previous approved version (or restore
the Agent destination symlink), then restart instances gradually. It does not
reintroduce an untracked production `.env` fallback. Hot reload, per-request
Vault reads, and automatic rotation orchestration are intentionally out of
scope for V1.

## Failure matrix

| Condition                                  | Expected behavior                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Missing Agent file before startup          | Dev/Production refuse to start                                         |
| Malformed or incomplete bundle             | Refuse to start with a safe configuration error                        |
| Vault unavailable after snapshot load      | Current process keeps its in-memory snapshot                           |
| Local explicit `env` source                | Allowed in development/test; temporary production override is explicit |
| Root or non-expiring root-derived identity | Forbidden for AIHUB                                                    |

See ADR-0013 and issue #30 for the architectural decision and adoption scope.

The smoke command is deliberately opt-in and requires both an explicit
environment and AppRole provenance:

```powershell
$env:AIHUB_VAULT_SMOKE_ALLOW = 'true'
$env:AIHUB_VAULT_SMOKE_AUTH_METHOD = 'approle'
$env:AIHUB_VAULT_ENVIRONMENT = 'staging'
pnpm vault:smoke
```

It checks required data reads, read-only capabilities, denied unrelated data
and metadata paths, and never performs a write/delete probe.
