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
secret/aihub/sandbox/sandbox-assertion
secret/aihub/{environment}/email-outbox
secret/aihub/{environment}/web-session
secret/aihub/{environment}/auth-mfa
```

All bundles except database, Redis, and sandbox-assertion are part of the V1
runtime-secret document. Those three bundles are rendered into a separate
connection document because they are process bootstrap configuration. The
Speaking question catalog uses the SeaweedFS bundle to create short-lived read
URLs for the public sample-audio endpoint, and the Resend bundle supplies the
verification-email provider credential. The `web-session` bundle holds the one
static secret the Customer Web BFF proves itself with on the Web Session routes;
it is required in production and staging. Provisioning its KV value can precede
the release, but rendering its new root key would break the previous image's
strict document reader. Keep the live templates unchanged until all old-image
consumers are stopped, then render and replace the image in the same maintenance
window. Follow the [coordinated release and rollback sequence](../../docs/operations/deploy-vps.md#release-order-when-a-rollout-adds-a-runtime-secret).

## Policy bootstrap

Run these commands from an operator-controlled session, never from AIHUB and
never with the application machine identity:

```powershell
vault policy write aihub-development-runtime ops/vault/policies/aihub-development-runtime.hcl
vault policy write aihub-staging-runtime ops/vault/policies/aihub-staging-runtime.hcl
vault policy write aihub-production-runtime ops/vault/policies/aihub-production-runtime.hcl
vault policy write aihub-sandbox-runtime ops/vault/policies/aihub-sandbox-runtime.hcl
```

The repository also includes an explicit operator-only provisioning helper. It
expects a private directory with `ai-speaking.json`, `ai-writing.json`,
`seaweedfs.json`, `resend.json`, `user-access-jwt.json`, `email-outbox.json`,
`web-session.json`, and `auth-mfa.json` containing only the flat bundle keys. It passes file paths
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

`auth-mfa.json` contains `current_key_id` and `keys`, both strings. `keys` is a
JSON object encoded as a string and maps key IDs to 32-byte base64 AES keys.
Keep previous key IDs in the map while enabled factors still reference them;
the new runtime reads this separate file, which the previous image ignores.
Provision this bundle and render the file before deploying the writer release.

The role is provisioned with `bind_secret_id=false`, so the Agent's role ID is a
complete credential and the Agent re-authenticates on its own after a restart
or a revoked token. `bound_cidr_list` is the constraint Vault requires when
`bind_secret_id` is off.

The helper writes the selected policy, creates an AppRole with a short token
TTL and bounded maximum TTL, and writes that tier's KV bundles. It refuses a
Vault `root` token, stores the generated role ID as `vault-role-id` in the
credentials directory with mode `0600`, and never prints secret values or the
role ID. Protect the directory with a private ACL on Windows or mode `0700` on
Unix; deliver the role ID to that tier's Agent through the deployment secret
channel. There is no Agent `secret_id` to rotate.

Before writing the policy or bundles, the helper validates that Production's
database URL targets `aihub`, Sandbox's runtime URL targets `aihub_sandbox`,
and Sandbox's control-plane reader targets `aihub` with a different login. It
also requires Sandbox Redis database `/1` and a dedicated non-default ACL
username; verify that user's actual key and command restrictions on Redis.

Install the role ID at that tier's host path before deleting the local
credentials directory. Production has ten input bundles and Sandbox has eleven;
the generated `vault-role-id` file is additional to those bundle files.

Production and Sandbox each have their own credential directory and Vault
policy. Production `database.json` and `redis.json` contain only `url`. The
Sandbox versions contain its own `url`; `database.json` also contains
`control_plane_read_url`, the least-privilege Postgres login that can select
only the Organization, API-key, and identity-configuration columns used for
request authentication and update only `api_keys.last_used_at`. Only the
Sandbox directory contains `sandbox-assertion.json`. Do not copy Production
provider, JWT, Resend, SeaweedFS, email-outbox, web-session, or MFA credentials
into it; create separate Sandbox credentials. Use a separate Resend key where
the provider supports it.
The Sandbox Redis URL must use a dedicated ACL user, database `/1`, and
`?keyPrefix=aihub-sandbox%3A`. The shared Redis client factory applies that
prefix to key commands, and the Redis ACL limits this user to
`aihub-sandbox:*`, which keeps Production keys inaccessible before the client
selects database `/1`.

Run the helper once for each tier, changing `AIHUB_VAULT_ENVIRONMENT` and the
credentials directory to `production` or `sandbox`. Sandbox provisioning writes
eleven bundles; Production writes ten and cannot read the Sandbox signing key.

The AppRole policy must be read-only and must not receive `root`, `sys`, auth
management, write, delete, or broad-list capabilities. Revoke bootstrap/root
sessions after provisioning and verify the resulting identity with a manual
smoke test.

## Agent template

`templates/runtime-secrets.json.ctmpl` renders the JSON shape consumed by the
AIHUB runtime-secret provider. `templates/auth-mfa-secrets.json.ctmpl` renders
the separate MFA keyring. `templates/connection-secrets.json.ctmpl` renders
database, Redis, and Sandbox-only assertion signing material. Set
`AIHUB_VAULT_ENVIRONMENT` independently on both Agents; each renders the same
three filenames under its own directory. The Sandbox policy reads only
`secret/aihub/sandbox/*`; Production, staging, and development cannot read a
`sandbox-assertion` path.

The rendered file must be readable only by the AIHUB service account. Its
directory must not be world-readable, and the file must not be copied into
application logs, images, backups, or source control.

## Safe verification

Use the repository's opt-in `pnpm vault:smoke` command only with a dedicated,
non-root AppRole identity. It reports path access and policy failures without
printing Vault responses or secret values. The Sandbox check also confirms
every Production path is denied; the Production check confirms the Sandbox
signing path is denied. It is not part of CI or the default verification loop.
Set `AIHUB_VAULT_SMOKE_AUTH_METHOD=approle` as proof that the operator
authenticated through the intended machine-identity flow. The check uses
capability reads for unrelated and cross-tier paths rather than performing a
write/delete probe.

For a manual smoke check, capture the AppRole login token into the shell
environment so it is not printed or stored in the CLI token helper:

```powershell
$env:VAULT_TOKEN = vault write -field=token auth/approle/login `
  'role_id=@C:\secure\aihub\sandbox\vault-role-id'
$env:AIHUB_VAULT_SMOKE_ALLOW = 'true'
$env:AIHUB_VAULT_SMOKE_AUTH_METHOD = 'approle'
$env:AIHUB_VAULT_ENVIRONMENT = 'sandbox'
pnpm vault:smoke
Remove-Item Env:VAULT_TOKEN
```

Use the matching Production role ID and environment for the Production smoke
check. Keep shell tracing disabled while capturing the token.
