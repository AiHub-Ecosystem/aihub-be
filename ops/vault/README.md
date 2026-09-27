# AIHUB Vault bootstrap

This directory contains the non-secret Vault policy and Agent template used by
AIHUB. It never contains a Vault address, token, role ID, secret ID, or runtime
credential.

## KV paths

The existing KV v2 mount is the source of runtime secrets:

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

The first five bundles are part of the V1 runtime-secret document. The
database, Redis, and sandbox-assertion bundles are rendered into a separate
connection document because they are process bootstrap configuration. The
Speaking question catalog uses the SeaweedFS bundle to create short-lived read
URLs for the public sample-audio endpoint, and the Resend bundle supplies the
verification-email provider credential.

## Policy bootstrap

Run these commands from an operator-controlled session, never from AIHUB and
never with the application machine identity:

```powershell
vault policy write aihub-development-runtime ops/vault/policies/aihub-development-runtime.hcl
vault policy write aihub-staging-runtime ops/vault/policies/aihub-staging-runtime.hcl
vault policy write aihub-production-runtime ops/vault/policies/aihub-production-runtime.hcl
```

The repository also includes an explicit operator-only provisioning helper. It
expects a mode-700 directory with `ai-speaking.json`, `ai-writing.json`,
`seaweedfs.json`, `resend.json`, and `user-access-jwt.json` containing only the flat bundle keys. It passes file paths to
the Vault CLI, never secret values:

```powershell
$env:AIHUB_VAULT_PROVISION_ALLOW = 'true'
$env:AIHUB_VAULT_ENVIRONMENT = 'staging'
$env:AIHUB_VAULT_CREDENTIALS_DIR = 'C:\secure\aihub-vault\staging'
pnpm vault:provision
```

The helper writes the selected policy, creates an AppRole with a short token
TTL and bounded maximum TTL, and writes all eight KV bundles. The credential
directory must also contain `database.json`, `redis.json`, and
`sandbox-assertion.json` with the flat keys used by the connection template.
`database.json` contains `url`, `sandbox_url`, and
`sandbox_control_plane_read_url`. The last value is a separate least-privilege
Postgres login for the sandbox process: it can select the Organization,
API-key, and identity-configuration columns used for request authentication,
and update only `api_keys.last_used_at`. It cannot change control-plane data.
Deliver the Role
ID and one-time Secret ID to Vault Agent through the deployment secret channel;
never commit or paste them into an issue.

The AppRole policy must be read-only and must not receive `root`, `sys`, auth
management, write, delete, or broad-list capabilities. Revoke bootstrap/root
sessions after provisioning and verify the resulting identity with a manual
smoke test.

## Agent template

`templates/runtime-secrets.json.ctmpl` renders the JSON shape consumed by the
AIHUB runtime-secret provider. `templates/connection-secrets.json.ctmpl`
renders database, Redis, and sandbox bootstrap material. Set
`AIHUB_VAULT_ENVIRONMENT` in the Agent process; both files are rendered under
the shared runtime directory.

The rendered file must be readable only by the AIHUB service account. Its
directory must not be world-readable, and the file must not be copied into
application logs, images, backups, or source control.

## Safe verification

Use the repository's opt-in `pnpm vault:smoke` command only with a dedicated,
non-root AppRole identity. It reports path access and policy failures without
printing Vault responses or secret values. It is not part of CI or the default
verification loop. Set `AIHUB_VAULT_SMOKE_AUTH_METHOD=approle` as proof that
the operator authenticated through the intended machine-identity flow. The
check uses Vault capability reads for unrelated paths rather than performing a
write/delete probe.
