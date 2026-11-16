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
secret/aihub/{environment}/database-pooler
secret/aihub/{environment}/redis
secret/aihub/{environment}/sandbox-assertion
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
```

The repository also includes an explicit operator-only provisioning helper. It
expects a mode-700 directory with `ai-speaking.json`, `ai-writing.json`,
`seaweedfs.json`, `resend.json`, `user-access-jwt.json`, `email-outbox.json`,
`web-session.json`, and `auth-mfa.json` containing only the flat bundle keys. It passes file paths
to the Vault CLI, never secret values:

```powershell
$env:AIHUB_VAULT_PROVISION_ALLOW = 'true'
$env:AIHUB_VAULT_ENVIRONMENT = 'staging'
$env:AIHUB_VAULT_CREDENTIALS_DIR = 'C:\secure\aihub-vault\staging'
$env:AIHUB_VAULT_AGENT_CIDR = '172.16.2.1/32'
$env:AIHUB_VAULT_SECRET_ID_FILE = 'C:\secure\aihub-vault\staging\secret-id'
# Required when database-pooler.json is present:
$env:AIHUB_PGBOUNCER_VAULT_SECRET_ID_FILE = 'C:\secure\aihub-vault\staging\secret-id-pgbouncer'
bun run vault:provision
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
Never reuse an id for different key material: an envelope sealed under the old
material no longer opens, and the outbox treats such a payload as unreadable.

`AIHUB_VAULT_AGENT_CIDR` is the address **Vault records as the login source**.
That is not the Agent container's IP. The Agent and Vault sit on separate Docker
networks, so Docker NATs every cross-network connection to the Vault-side
gateway before Vault sees it. On the production host that is `172.16.2.1/32`
while the Agent's own address is `172.16.7.x`, and no login from the Agent is
ever attributed to `172.16.7.x`. Read this value from a rejected login in the
Vault audit log, not from `docker inspect`.

Because every container on the host is NATed to that same gateway, this
constraint blocks logins from outside the VPS but does not distinguish one
container on it from another. The `secret_id` provisioned below is the
per-Agent factor: a container holding the role ID and reaching the same gateway
still cannot log in. The policy additionally limits what the resulting token
can read.

`auth-mfa.json` contains `current_key_id` and `keys`, both strings. `keys` is a
JSON object encoded as a string and maps key IDs to 32-byte base64 AES keys.
Keep previous key IDs in the map while enabled factors still reference them;
the new runtime reads this separate file, which the previous image ignores.
Provision this bundle and render the file before deploying the writer release.

The role is provisioned with `bind_secret_id=true` and no Secret ID TTL or use
limit. The helper mints the Secret ID under a five-minute response wrap and
unwraps it directly into `AIHUB_VAULT_SECRET_ID_FILE` (and the PgBouncer file
when applicable), so the value is never printed. The Agent mounts both files
and re-authenticates on its own after a restart or a revoked token.
`secret_id_bound_cidrs` stays as a second, off-host boundary. Each runtime and
PgBouncer role also has a 12-per-minute login quota with a one-minute block;
the `role` parameter on `sys/quotas/rate-limit` works in Vault Community
Edition. On role-ID or Secret ID
compromise, rotate the AppRole: both credential files change together and the
Agent restarts. See [ADR-0171](../../docs/adr/0171-vault-runtime-login-requires-a-secret-id.md).

The helper writes the selected policy, creates an AppRole with a short token
TTL and bounded maximum TTL, and writes the runtime KV bundles. If the
operator-only directory also contains `database-pooler.json`, the helper
validates its capacity evidence and approvals, then writes the separate
`database-pooler` bundle. Pooler provisioning is optional until the rollout
gate in the deployment runbook is met. The credential
directory must also contain `database.json`, `redis.json`, and
`sandbox-assertion.json` with the flat keys used by the connection template.
`database.json` contains `url`, `sandbox_url`, `email_wal_url`,
`sandbox_email_wal_url`, and
`sandbox_control_plane_read_url`. The last value is a separate least-privilege
Postgres login for the sandbox process: it can select the Organization,
API-key, and identity-configuration columns used for request authentication,
and update only `api_keys.last_used_at`. It cannot change control-plane data.
`redis.json` also contains `email_send_rate_url`, the dedicated shared Redis
connection for the Resend account-wide email pace. Provision the same URL in the
Production and Sandbox bundles, separate from both environment-specific Redis
URLs.
email_send_budget_url is also present in both bundles and must point at the
same Production database through a dedicated login with access only to
email_daily_send_budgets. The daily counter is shared by every deployment using
the Resend account; provision the same URL in Production and Sandbox, separate
from the outbox database URLs.
The WAL URLs are direct PostgreSQL connections for dedicated `LOGIN
REPLICATION` users with `pg_monitor` access, one per environment database.
They bypass PgBouncer and are not pooler credentials; `email_wal_url` belongs
to Production and `sandbox_email_wal_url` belongs to Sandbox.

When approved, `database.json` may additionally include distinct pooler URLs
for the runtime, control-plane, read, and email-budget connection roles. The
connection template renders these optional keys; a runtime with
`AIHUB_DATABASE_POOLER_ENABLED=true` fails closed if any required role URL is
missing. The operator CLI and migration entrypoint always select direct URLs.

`database-pooler.json` is a separate strict bundle. It contains the measured
`max_connections` (currently held at 100), dated evidence for reserved slots,
owner-approved operational headroom, a `max_client_conn` cap, separate
PgBouncer admin/stats credentials, an owner-approved attestation that the direct
clients and aliases cover the complete cluster-client inventory, an
owner-approved `capacity_evidence_valid_through` date, and every direct client's
approved pool maximum and process overlap. Expired capacity evidence blocks
provisioning. Each alias names one
of `aihub-be`, `ai-writing`, `ai-speaking`, or `ai-portal` and records its target host/database,
`max_db_connections`, approved client pool maximum and process overlap, a
per-alias client cap, owner evidence, and its database users/passwords. All four
AIHUB application budgets must be present. One app may reuse its existing
credential across its aliases; different apps must use separate existing
credentials. This does not create or change PostgreSQL roles. The validator
checks that the sum of the four configured `AIHUB_POSTGRES_POOL_MAX_*` values
matches the AIHUB BE aliases' `client_pool_max` values, that alias client caps
equal pool maximum times overlap,
`max_client_conn` includes all alias caps plus admin/stats slots, and backend
caps plus direct clients and headroom fit under the PostgreSQL connection
budget after reserved slots. No target cap is implied by historical
measurements; owner evidence is required before this bundle can be provisioned.
The separate `aihub-{environment}-pgbouncer` AppRole can read only this bundle;
the application runtime identity cannot read it.

Use a dedicated Redis ACL user limited to the two keys the limiter touches: the
pacing key `aihub:resend:email-send-rate:last-reservation-ms` and the
provider-outage state `aihub:resend:email-provider-outage` (ADR-0122). Create it
with exactly this grant, replacing `<password>` and `<limiter-db>`:

```text
ACL SETUSER aihub_email_limiter on ><password> resetkeys ~aihub:resend:email-send-rate:last-reservation-ms ~aihub:resend:email-provider-outage -@all +select|<limiter-db> +client|setinfo +info +eval +time +get +set +hget +hmget +hset +hdel +pexpire +del
```

`SELECT` is limited to the limiter database; `CLIENT SETINFO` and `INFO` are
what ioredis sends on connect; the rest are the commands the limiter's scripts
call. `redis-email-send-rate-limiter.acl.spec.ts` compares this line with the
keys and commands in the source, so a script that reads a new key or runs a new
command fails CI until this grant is updated. Redis refuses an ungranted key with
`NOPERM` and the limiter then reports itself unavailable, so no email is sent;
apply any change to this line to the running Redis too. Persist the user with
`ACL SAVE` against a configured, durable ACL file before storing its URL in
Vault. Verify authentication and a read-only script with that user, and use
`ACL DRYRUN` to verify `SET` access without reserving a real send slot.

Deliver both the Role ID and the Secret ID to Vault Agent through the
deployment secret channel; never commit or paste either into an issue. Both are
host files owned by `10001:10001` with mode `0600`.

The AppRole policy must be read-only and must not receive `root`, `sys`, auth
management, write, delete, or broad-list capabilities. Revoke bootstrap/root
sessions after provisioning and verify the resulting identity with a manual
smoke test.

## Agent template

`templates/runtime-secrets.json.ctmpl` renders the JSON shape consumed by the
AIHUB runtime-secret provider. `templates/auth-mfa-secrets.json.ctmpl` renders
the separate MFA keyring. `templates/connection-secrets.json.ctmpl` renders
database, Redis, and sandbox bootstrap material. The email WAL login is rendered
to its own `email-wal-secrets.json` file so N-1 images can ignore its new fields.
`agent/aihub-pgbouncer.hcl`
and its three templates render PgBouncer config, per-app userlist credentials,
and the dedicated exporter credential into a separate host directory. Set
`AIHUB_VAULT_ENVIRONMENT` in each Agent. The four runtime templates render to
the shared runtime directory; the pooler templates render to the separate
PgBouncer directory.

The rendered file must be readable only by the AIHUB service account. Its
directory must not be world-readable, and the file must not be copied into
application logs, images, backups, or source control.

## Safe verification

Use the repository's opt-in `bun run vault:smoke` command only with a dedicated,
non-root AppRole identity. It reports path access and policy failures without
printing Vault responses or secret values. It is not part of CI or the default
verification loop. Set `AIHUB_VAULT_SMOKE_AUTH_METHOD=approle` as proof that
the operator authenticated through the intended machine-identity flow. The
check uses Vault capability reads for unrelated paths rather than performing a
write/delete probe.

## Login visibility

The per-role login quota refuses a burst. The Secret ID stops a container
without it from succeeding, and the audit device makes every attempt visible,
including a single failed login that the quota does not reject. On the Vault
host, filter the file audit device for failed runtime logins (replace the path
with the one in `vault audit list`):

```sh
sudo jq -c 'select(.request.path == "auth/approle/login" and
  (.request.data.role_name | startswith("aihub-")) and
  ((.response.errors // []) | length > 0)) |
  {time, role: .request.data.role_name, from: .request.remote_address}' \
  /var/log/vault/audit.log | tail -n 50
```

An Agent with both credential files does not produce failed logins on restart.
Any line in that output is an unexplained runtime login attempt: find the source
container before treating it as noise. Run this after each Agent restart and on
the daily operator pass. See
[Vault runtime secrets](../../docs/operations/vault-runtime-secrets.md#login-visibility).
