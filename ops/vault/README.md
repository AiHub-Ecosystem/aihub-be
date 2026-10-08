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
secret/aihub/{environment}/email-outbox
secret/aihub/{environment}/web-session
```

All bundles except database, Redis, and sandbox-assertion are part of the V1
runtime-secret document. Those three bundles are rendered into a separate
connection document because they are process bootstrap configuration. The
Speaking question catalog uses the SeaweedFS bundle to create short-lived read
URLs for the public sample-audio endpoint, and the Resend bundle supplies the
verification-email provider credential. The `web-session` bundle holds the one
static secret the Customer Web BFF proves itself with on the Web Session routes;
it is required in production and staging, so stage it and restart vault-agent
before merging a change that needs it.

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
`seaweedfs.json`, `resend.json`, `user-access-jwt.json`, `email-outbox.json`,
and `web-session.json` containing only the flat bundle keys. It passes file paths
to the Vault CLI, never secret values:

```powershell
$env:AIHUB_VAULT_PROVISION_ALLOW = 'true'
$env:AIHUB_VAULT_ENVIRONMENT = 'staging'
$env:AIHUB_VAULT_CREDENTIALS_DIR = 'C:\secure\aihub-vault\staging'
$env:AIHUB_VAULT_AGENT_CIDR = '172.16.2.1/32'
pnpm vault:provision
```

`web-session.json` is required by the helper for the selected environment. It
contains only `client_secret`, a non-empty string shared with the Customer Web
BFF:

```json
{
  "client_secret": "<BFF client secret>"
}
```

Every value in a bundle file is a string. In `email-outbox.json` that includes
`keys`, which is a JSON object **encoded as a string**, mapping each key id to 32
random bytes in base64. The template inserts that string into the rendered
document as-is, so it must be valid JSON:

```json
{
  "current_key_id": "k2026-10",
  "keys": "{\"k2026-10\": \"<base64 of 32 random bytes>\"}"
}
```

Generate a key with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
To rotate, add the new id to `keys`, point `current_key_id` at it, and keep the
old id until no queued request still needs it (see the email outbox runbook).

`AIHUB_VAULT_AGENT_CIDR` is the address **Vault records as the login source**.
That is not the Agent container's IP. The Agent and Vault sit on separate Docker
networks, so Docker NATs every cross-network connection to the Vault-side
gateway before Vault sees it. On the production host that is `172.16.2.1/32`
while the Agent's own address is `172.16.7.x`, and no login from the Agent is
ever attributed to `172.16.7.x`. Read this value from a rejected login in the
Vault audit log, not from `docker inspect`.

Because every container on the host is NATed to that same gateway, this
constraint blocks logins from outside the VPS but does not distinguish one
container on it from another. It is a network boundary, not per-container
isolation; the policy is what limits what the resulting token can read.

The role is provisioned with `bind_secret_id=false`, so the Agent's role ID is a
complete credential and the Agent re-authenticates on its own after a restart
or a revoked token. `bound_cidr_list` is the constraint Vault requires when
`bind_secret_id` is off.

The helper writes the selected policy, creates an AppRole with a short token
TTL and bounded maximum TTL, and writes all ten KV bundles. The credential
directory must also contain `database.json`, `redis.json`, and
`sandbox-assertion.json` with the flat keys used by the connection template.
`database.json` contains `url`, `sandbox_url`, and
`sandbox_control_plane_read_url`. The last value is a separate least-privilege
Postgres login for the sandbox process: it can select the Organization,
API-key, and identity-configuration columns used for request authentication,
and update only `api_keys.last_used_at`. It cannot change control-plane data.
Deliver the Role ID to Vault Agent through the deployment secret channel; never
commit or paste it into an issue. There is no Agent `secret_id` to rotate.

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
