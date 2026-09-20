# Vault-backed runtime secrets

Production uses Vault Agent-rendered files. Local development and tests may use
an explicit `.env` source; production and staging never fall back to it.

## Source selection

AIHUB supports two explicit sources:

- `AIHUB_RUNTIME_SECRET_SOURCE=env` — development/test only.
- `AIHUB_RUNTIME_SECRET_SOURCE=agent-file` plus
  `AIHUB_RUNTIME_SECRETS_FILE=<agent-rendered JSON path>` — downstream AI,
  Resend, JWT, and SeaweedFS credentials.
- `AIHUB_RUNTIME_CONNECTION_SECRETS_FILE=<agent-rendered JSON path>` —
  database, Redis, and sandbox signing material. The process bootstrap selects
  the production or sandbox connection before Nest wiring.

If a required bundle is missing or malformed, startup fails closed. A process
that has already loaded a valid snapshot keeps using its in-memory snapshot
during a temporary Vault/Agent outage; it does not read Vault per request.

## Migration sequence

1. Apply the matching policy from `ops/vault/policies/` with an operator
   session. Never use the AIHUB runtime identity for policy administration.
2. Create the eight KV v2 bundles: `ai-speaking`, `ai-writing`, `seaweedfs`,
   `resend`, `user-access-jwt`, `database`, `redis`, and `sandbox-assertion`.
3. Provision the environment AppRole and configure Vault Agent to render both
   templates under the AIHUB service account.
4. Set the rendered-file paths in the deployment config channel. Do not put
   runtime credential values in `.env.production`.
5. Start one instance and run the opt-in AppRole smoke test. Verify health,
   Speaking/Writing dispatch, authentication, and redacted logs.
6. Roll the change across the deployment only after the first instance is
   healthy, then remove the migrated long-lived credentials from deployment
   environments.

## Rotation and rollback

Rotation is startup-only:

1. Write the replacement credential to a new KV version while the old one is
   still valid.
2. Confirm Agent renders the new snapshot without printing it.
3. Restart instances gradually and run health plus one safe downstream request.
4. Retire the old credential only after every instance is healthy.

Rollback restores the previous approved KV versions, restarts Vault Agent and
the application, and repeats the same checks. It never reintroduces a
production `.env` fallback. Hot reload, per-request Vault reads, and automatic
rotation orchestration remain out of scope.

## Failure matrix

| Condition                                  | Expected behavior                                           |
| ------------------------------------------ | ----------------------------------------------------------- |
| Missing Agent file before startup          | Production refuses to start                                 |
| Malformed or incomplete bundle             | Production refuses to start with a safe configuration error |
| Vault unavailable after snapshot load      | Current process keeps its in-memory snapshot                |
| Local explicit `env` source                | Allowed in development/test only                            |
| Root or non-expiring root-derived identity | Forbidden for AIHUB runtime                                 |

## Manual smoke test

Run only from a Vault CLI session authenticated as the generated non-root
AppRole. It reads required data paths, checks exact read-only capabilities, and
confirms unrelated paths and metadata are denied without printing values:

```powershell
$env:AIHUB_VAULT_SMOKE_ALLOW = 'true'
$env:AIHUB_VAULT_SMOKE_AUTH_METHOD = 'approle'
$env:AIHUB_VAULT_ENVIRONMENT = 'production'
pnpm vault:smoke
```
