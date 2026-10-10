# VPS deployment

This is the production baseline for the single-node Compose deployment. It uses
the existing production `aihub-db` and Wispace Redis, and renders downstream
runtime credentials through Vault Agent. When sandbox isolation is enabled,
`app-sandbox` is a second container from the same image. Its usage,
idempotency, and dispatch budgets use `aihub_sandbox` and Redis logical
database `/1`; Organization, API-key, and identity-configuration records stay
in the production control-plane database and are read through a least-privilege
database login.

**Public TLS is terminated by nginx on the host, not by this Compose stack.**
The `app` service binds `127.0.0.1:${AIHUB_APP_PORT}` and `app-sandbox` binds
`127.0.0.1:${AIHUB_SANDBOX_APP_PORT}`; nginx owns ports 80 and 443 and proxies
each hostname to its matching loopback port. See
[The public edge](#the-public-edge) before changing hostnames or certificates.

## Prerequisites

- Docker Engine with the Compose plugin.
- DNS `A/AAAA` for `AIHUB_PRODUCTION_HOST` pointing to this VPS, and an nginx
  server block for it. Ports 80 and 443 are already held by nginx.
- Add DNS and an nginx server block for `AIHUB_SANDBOX_HOST` when it is
  configured. Leave an unused tier blank: a blank tier is absent from the
  application's hostname map, so no `Host` header can select it.
- nginx uses `AIHUB_APP_PORT` (default `3021`) as its upstream.
- An isolated sandbox needs `AIHUB_SANDBOX_ENABLED=true`,
  `AIHUB_SANDBOX_HOST`, `AIHUB_SANDBOX_ORG_IDS`, and
  `AIHUB_SANDBOX_APP_PORT` (default `3022`). Its database and Redis URLs are
  stored in the Vault connection bundles.
- The existing Docker network `aihub_aihub-network` with a healthy `aihub-db` container.
- A production Vault AppRole whose policy can read only the exact AIHUB runtime
  paths under `secret/data/aihub/production/`.
- A Vault operator session that can provision the AIHUB bundles, including the
  existing Wispace Redis credential, without using the runtime identity.
- A CA file trusted by Vault, plus the AppRole `role_id` and one-use `secret_id`.
- A release image in the registry, or a local Docker build.

Do not reuse the development AppRole or the development rendered snapshot.

## Prepare the host

Clone the release into a dedicated directory, then create the secret mounts outside
the repository. The runtime directory must be writable by UID/GID `10001`, because
both Vault Agent and the application run as that non-root identity.

```sh
sudo install -d -o 10001 -g 10001 -m 0700 /srv/aihub/secrets/runtime
sudo install -d -m 0700 /srv/aihub/secrets
sudo install -m 0600 -o 10001 -g 10001 vault-ca.pem /srv/aihub/secrets/vault-ca.pem
sudo install -m 0600 -o 10001 -g 10001 vault-role-id /srv/aihub/secrets/vault-role-id
cp .env.production.example .env.production
chmod 600 .env.production
```

Set hostnames, Vault address, file paths, provider URLs, and ordinary storage
configuration in `.env.production`. Vault Agent supplies downstream credentials,
database/Redis URLs, the User Access JWT key, SeaweedFS credentials, and sandbox
signing material at runtime. None of those secret values belong in
`.env.production`.

Set `CUSTOMER_WEB_BASE_URL` to the production Customer Web HTTPS URL. Set the
separate `CUSTOMER_WEB_SANDBOX_BASE_URL` only when a sandbox Customer Web is
deployed. Until then, the API-only sandbox may leave it blank and keeps
token-only emails. Both URLs may include a path prefix, but must not include
credentials, a query, or a fragment.

`AIHUB_PRODUCTION_HOST` is the only required host setting. Setting
`AIHUB_SANDBOX_ENABLED=true` and the sandbox host/organization allowlist enables
the isolated Compose profile; the connection bundle supplies its database and
Redis URLs. Serving the hostname is a separate nginx change described in
[The public edge](#the-public-edge). Leaving the sandbox flag false keeps the
sandbox host and container absent.

`AIHUB_SELF_SERVE_MONTHLY_REQUEST_QUOTA` sets the monthly request quota, in
requests, that a new Organization starts on when a customer creates one through
`POST /v1/organizations` (ADR-0041). It has no default in Compose: leaving it
blank uses the built-in value of 100. It must be a positive integer — zero and
fractions stop the process at boot rather than starting an Organization that
could not answer a single request, and "no limit" is a quota of NULL set on the
Organization itself. The value applies only to Organizations created after the
restart; an existing Organization keeps the quota already stored on it, and
raising one is an operator SQL or CLI act, not this variable. The full set of
terms is an Organization's own row, so this setting never retrofits existing
tenants.

Point the gateway at the existing production database over the shared Docker
network. Store the URL-encoded production and sandbox URLs, plus the Sandbox
read-only control-plane URL, in the operator-only Vault bundles. Create the
reader role on the production database with only the columns needed for Sandbox
admission and authentication:

```sql
CREATE ROLE aihub_sandbox_reader LOGIN;
GRANT CONNECT ON DATABASE aihub TO aihub_sandbox_reader;
GRANT USAGE ON SCHEMA public TO aihub_sandbox_reader;
GRANT SELECT (id, status, entitlements, rate_limit_rpm, max_concurrent,
              monthly_request_quota, hard_stop_on_quota)
  ON organizations TO aihub_sandbox_reader;
GRANT SELECT (id, organization_id, key_hash, status, scopes,
              allowed_environments, expires_at, last_used_at),
      UPDATE (last_used_at)
  ON api_keys TO aihub_sandbox_reader;
GRANT SELECT (organization_id, issuer, jwks_url, public_keys_jwks,
              allowed_algorithms, max_assertion_ttl_seconds, status,
              jwks_cache_version)
  ON organization_identity_configs TO aihub_sandbox_reader;
```

Set the role password interactively with `\password aihub_sandbox_reader`;
store its URL only in the operator-managed Vault `database.json` bundle:

```json
// database.json
{"url":"postgresql://aihub_admin:<password>@aihub-db:5432/aihub","sandbox_url":"postgresql://aihub_admin:<password>@aihub-db:5432/aihub_sandbox","sandbox_control_plane_read_url":"postgresql://aihub_sandbox_reader:<password>@aihub-db:5432/aihub"}
// redis.json
{"url":"redis://:<password>@redis.aihubproduction.com:6379/0","sandbox_url":"redis://:<password>@redis.aihubproduction.com:6379/1"}
```

The application reads the selected URL from Vault Agent at startup; neither
URL is passed through Compose interpolation.

Speaking sample audio is stored in SeaweedFS. Keep `SEAWEEDFS_ENDPOINT_URL`
(`https://s3.wispace.app`), `SEAWEEDFS_BUCKET` (`aihub-speaking-samples`), and
the SeaweedFS credentials in the runtime secret bundle. To create the bucket
and upload the normalized sample set from an operator workstation, use the
repository script without committing credentials:

```powershell
$env:SEAWEEDFS_ACCESS_KEY_ID = '<access-key>'
$env:SEAWEEDFS_SECRET_ACCESS_KEY = '<secret-key>'
node scripts/cli/upload-speaking-audio.mjs --source E:\audios
Remove-Item Env:\SEAWEEDFS_ACCESS_KEY_ID, Env:\SEAWEEDFS_SECRET_ACCESS_KEY
```

User Account Avatars (ADR-0068) live in their own bucket, named by
`SEAWEEDFS_USER_ASSET_BUCKET` (for example `aihub-user-assets`). It has no
default and never falls back to the Speaking sample bucket: while it is unset,
the Avatar routes answer `503 AVATAR_STORAGE_UNAVAILABLE` and nothing else is
affected. Create the bucket with the same SeaweedFS credentials and set the
variable before deploying.

The Sandbox deployment needs its own Avatar bucket, named by
`SEAWEEDFS_SANDBOX_USER_ASSET_BUCKET` (for example
`aihub-sandbox-user-assets`). Production and Sandbox keep their Avatar records
in different databases, so a shared bucket would make each deployment's sweep
treat the other's live Avatars as orphans and delete them. While the variable
is unset, Sandbox Avatar routes answer `503 AVATAR_STORAGE_UNAVAILABLE`, and
Sandbox never falls back to the production bucket. The Sandbox bucket needs the
same anonymous read-only grant as the production one.

Speaking Audio uploads use separate private buckets, `aihub-speaking-recordings`
and `aihub-sandbox-speaking-recordings`, configured through
`SEAWEEDFS_AUDIO_ASSET_BUCKET` and
`SEAWEEDFS_SANDBOX_AUDIO_ASSET_BUCKET`. Both buckets were created on the VPS on
2026-10-04. Anonymous list, read of a temporary probe object, write, and delete
each returned `403` against both local S3 buckets; anonymous bucket listing
through `https://s3.wispace.app` also returned `403` for both. No public policy
was applied.

Set each environment's exact bucket variable when deploying #207. Upload and
cleanup operations fail closed when the selected environment's bucket name or
SeaweedFS credentials are unavailable; they never use the sample or Avatar
buckets.

Avatars are published, not signed (ADR-0069). Each Avatar bucket must allow
anonymous **read of objects only**: no anonymous list, write, or delete. That is
a per-bucket S3 policy set through the S3 API with the existing SeaweedFS
identity; the host's `s3.json` is not touched. Create the bucket and apply the
policy once per bucket (on 2026-10-02 this was done for `aihub-user-assets` and
`aihub-sandbox-user-assets`):

```python
import json, boto3

s3 = boto3.client("s3", endpoint_url="http://127.0.0.1:8333",
                  aws_access_key_id=..., aws_secret_access_key=...)
bucket = "aihub-user-assets"  # and aihub-sandbox-user-assets
s3.create_bucket(Bucket=bucket)
s3.put_bucket_policy(Bucket=bucket, Policy=json.dumps({
    "Version": "2012-10-17",
    "Statement": [{
        "Sid": "PublicReadGetObject", "Effect": "Allow", "Principal": "*",
        "Action": "s3:GetObject", "Resource": f"arn:aws:s3:::{bucket}/*",
    }],
}))
```

Run it on the SeaweedFS host against the local S3 port, with the identity's
credentials read from the host's secret store, never typed into a shell history
or committed. Until a bucket carries the policy, its Avatar images answer `403`
and the Customer Web shows its fallback. Check the grant from a client outside
the AIHUB network, without credentials, against an uploaded probe object that
you delete afterwards:

- `GET https://s3.wispace.app/<bucket>/<an Avatar object key>` answers `200`
  with the image's `Content-Type` and `Cache-Control: public, max-age=3600`;
- `GET https://s3.wispace.app/<bucket>/` (a bucket listing) answers `403`;
- an anonymous `PUT` and `DELETE` of an object answer `403`;
- a Speaking sample object in `aihub-speaking-samples` still answers `403`.

Both Avatar buckets passed every check on 2026-10-02, including the
`Cache-Control` header (ADR-0069). If it is ever missing from the first
response, record that in ADR-0069: the one-hour cache bound then depends on
browser heuristics. An upload must be
completed within one hour; a completion older than that answers `404` and
deletes the object.

### Sweeping Speaking Audio upload orphans

`speaking:audio-upload-sweep` removes rejected uploads and incomplete intents
whose one-hour expiry passed at least 24 hours ago. It deletes only the exact
object key in each intent, then removes that intent. A missing object is an
idempotent success; failed deletion keeps the intent for the next retry. Run it
daily for Production and Sandbox after the corresponding bucket variables and
runtime credentials are configured.
Start with a dry run in each environment:

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  exec -T app node scripts/runtime/runtime-entrypoint.mjs scripts/cli/cli.mjs speaking:audio-upload-sweep --dry-run true

docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  --profile sandbox exec -T app-sandbox node scripts/runtime/runtime-entrypoint.mjs scripts/cli/cli.mjs speaking:audio-upload-sweep --dry-run true
```

After reviewing the counts, run the same commands without `--dry-run true` and
add them to the daily operator job alongside the Avatar sweep. Each invocation
uses that deployment's database and environment-specific bucket. It prints one
JSON line containing only `scanned`, `eligible`, `deleted`, `failed`, and
`dryRun`; it never prints an object key or End-User ID. Any failed delete makes
the command exit non-zero so the next scheduled run can retry it.

### Sweeping orphaned Avatar objects

Objects that were uploaded but never completed, or whose immediate delete
failed, are removed by `avatar:sweep`. It lists the Avatar prefix, keeps every
object that an Avatar record names, and deletes the rest once they are older
than **24 hours** by the storage server's own last-modified time. It touches
only keys of the exact form
`users/usr_<ULID>/avatar/ava_<ULID>/original`; any other key is left alone and
counted as unrecognised. The one-hour completion window and the 24-hour grace
leave a 23-hour gap in which an object can neither be completed nor swept, so
the two can never act on the same object. Both are constants in the code, not
settings.

Run it once a day for each deployment, like `usage:prune`, after its bucket
setting exists. **Run it with `--dry-run true` first**, check the summary, and
only then enable the cron entry:

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  exec -T app node scripts/runtime/runtime-entrypoint.mjs scripts/cli/cli.mjs avatar:sweep --dry-run true

docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  exec -T app node scripts/runtime/runtime-entrypoint.mjs scripts/cli/cli.mjs avatar:sweep

docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  --profile sandbox exec -T app-sandbox node scripts/runtime/runtime-entrypoint.mjs scripts/cli/cli.mjs avatar:sweep
```

The production image has no `pnpm`, and `docker compose exec` skips the
container entrypoint that loads the runtime secrets, so the command goes
through `scripts/runtime/runtime-entrypoint.mjs`, which loads them and then hands the
rest of the arguments to the CLI. Detach stdin (`</dev/null`) when running it
from a script, or `exec` consumes the script's own input.

The daily run is a user crontab entry on the host, `30 3 * * *` in the server's
UTC clock, which calls a small script that runs the command above for production
and then for Sandbox, with stdin detached, and appends one line per environment
to a log. The script exits non-zero when either run failed; alert on that and on
a missing line for either environment.

It prints one JSON line of counts (`scanned`, `unrecognised`, `orphaned`,
`deleted`, `failed`, `dryRun`) and never an object key. It exits non-zero when
any delete failed, or when the bucket, the storage credentials, or the
database is not configured, in which case it has deleted nothing. Alert on a
non-zero exit and on a missed run for either container.

### Scheduled operator jobs

The other three scheduled operator commands run from one host script,
`~/aihub-ops-job.sh <quota|prune|report>`, built the same way as the Avatar
sweep (production then Sandbox, stdin detached, one log line per environment in
`~/aihub-ops-job.log`, non-zero exit when either failed). Crontab, in the
server's UTC clock:

```text
0 2 * * *  aihub-ops-job.sh quota    # quota:reconcile
30 2 * * * aihub-ops-job.sh prune    # usage:prune, after the reconcile
5 * * * *  aihub-ops-job.sh report   # usage:report for the previous whole UTC hour
```

`report` computes `--from` and `--to` as the start of the previous and of the
current UTC hour, so `to` is never in the future. The script is not in the
repository (it holds the host path and the `sudo` form); the three operator
guides own the command, its exit codes, and what to alert on. Before the first
scheduled `prune` the database was backed up with `pg_dump -Fc` and the command
was run by hand in each container (`deleted: 0`, nothing was 13 months old).

The Compose file does not create a second Postgres service or volume. Verify the
existing service before starting the gateway:

```sh
docker network inspect "${AIHUB_DATABASE_NETWORK:-aihub_aihub-network}" >/dev/null
docker inspect --format '{{.State.Health.Status}}' aihub-db
```

The production Redis endpoint is `redis.aihubproduction.com:6379`; verify that
the VPS firewall permits the Redis protocol before starting the gateway. Do not
grant the AIHUB runtime AppRole access to the `wispace-bots` path; the operator
copies only the required password into the AIHUB `redis` bundle. Redis `/1` is not a
durable isolation boundary: it keeps sandbox counters/cache keys out of the
production logical database, while Postgres remains the durable boundary.

## Provision production Vault data

Use the repository helper with the production operator workflow. It writes the
ten production KV paths and never prints secret values:

```sh
AIHUB_VAULT_PROVISION_ALLOW=true \
AIHUB_VAULT_ENVIRONMENT=production \
AIHUB_VAULT_CREDENTIALS_DIR=/secure/aihub/production \
AIHUB_VAULT_AGENT_CIDR=172.16.2.1/32 \
  node ops/vault/provision-runtime-secrets.mjs
```

The directory contains `ai-speaking.json`, `ai-writing.json`, `resend.json`,
`user-access-jwt.json`, `seaweedfs.json`, `database.json`, `redis.json`,
`sandbox-assertion.json`, `email-outbox.json`, and `web-session.json`. Keep it
mode `0700` and remove it after provisioning. The required flat bundle shapes,
including the `client_secret` string in `web-session.json`, are documented in
[Vault bootstrap](../../ops/vault/README.md#policy-bootstrap).

`AIHUB_VAULT_AGENT_CIDR` is the address Vault records as the login source, not
the Agent container's IP. The Agent and Vault run on separate Docker networks,
so Docker NATs the connection to the Vault-side gateway first: on this host the
Agent is at `172.16.7.x` but Vault sees `172.16.2.1`. Read the value from a
rejected login in the Vault audit log.

The role is provisioned with `bind_secret_id=false` so the Agent authenticates
with its role ID alone and can re-authenticate whenever it is restarted, and
with `bound_cidr_list` as the constraint Vault requires in that mode. Because
every container on the host is NATed to the same gateway, that constraint blocks
logins from outside the VPS but does not distinguish containers on it; the
runtime policy is what limits what the token can read.

Provisioning requires a non-root operator identity. The Agent needs no
`secret_id`; the operator's own session does. Mint one with
`vault write -f auth/approle/role/aihub-production-runtime/secret-id` and unset
`VAULT_TOKEN` afterwards so the next CLI call cannot fall back to the operator
token. Validate the policy with the smoke script before starting the application:

```sh
AIHUB_VAULT_SMOKE_ALLOW=true \
AIHUB_VAULT_SMOKE_AUTH_METHOD=approle \
AIHUB_VAULT_ENVIRONMENT=production \
  node scripts/ops/vault-smoke.mjs
```

Run the smoke command from a Vault CLI session authenticated as the generated
non-root AppRole, not as the provisioning operator or a root token.

## Start the Vault-backed stack

Validate interpolation first; this does not start containers:

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml config --quiet
```

Before recreating Vault Agent, verify its operator-provisioned role ID file.
The current AppRole uses `bind_secret_id=false`, so the Agent re-authenticates
with that role ID and needs no one-use SecretID. CD does not provision the role
or recreate the Agent. A rollout that changes the rendered document schema must
follow the coordinated release sequence below before changing mounted files.

Build or pull the release, start dependencies and Vault Agent, run migrations once,
then start the app:

```sh
docker compose --env-file .env.production -f docker-compose.production.yml build app
docker compose --env-file .env.production -f docker-compose.production.yml up -d vault-agent
docker compose --env-file .env.production -f docker-compose.production.yml --profile migration run --rm migrate
docker compose --env-file .env.production -f docker-compose.production.yml --profile migration --profile sandbox run --rm migrate-sandbox
docker compose --env-file .env.production -f docker-compose.production.yml up -d app
docker compose --env-file .env.production -f docker-compose.production.yml --profile sandbox up -d app-sandbox
# Replace api.example.com with AIHUB_PRODUCTION_HOST from .env.production.
curl --fail https://api.example.com/health
```

Run the two Sandbox-profile commands only when `AIHUB_SANDBOX_ENABLED=true`.

### Adding the standalone MFA keyring

The MFA cipher reads `/run/secrets/aihub/auth-mfa-secrets.json`, separate from
the strict `runtime-secrets.json` document. Prepare it before the first release
that writes MFA state:

1. Add the read path from `ops/vault/policies/aihub-production-runtime.hcl` to
   the production runtime policy and provision
   `secret/aihub/production/auth-mfa` with `current_key_id` and `keys`.
2. Add
   `AIHUB_AUTH_MFA_SECRETS_FILE=/run/secrets/aihub/auth-mfa-secrets.json` to
   `.env.production`. Copy the new Agent HCL and template to the host, then
   recreate only `vault-agent` so it starts rendering the separate keyring.
3. Check that the keyring file exists, the Agent authenticated recently, and
   the existing runtime and connection documents are unchanged. Do not print
   any key values. The running N-1 app ignores the new file and its environment
   variable, so it can keep serving during this preparation.
4. Merge and deploy the writer release only after those checks. The deployed
   #489 reader skips the new outbox kinds until the writer is present.

Rollback to N-1 can leave the separate keyring file, Agent template, and Vault
read grant in place. The old image ignores them, and the MFA migrations are
additive; do not delete factor data or key versions during an image rollback.

### Release order when a rollout adds a runtime secret

CD deploys `main` and never restarts `vault-agent`. The new image must have its
required secrets at startup, but the rendered document must also remain valid
for every image still using it. The pre-Web-Session image rejects the new
`web-session` root key, so rendering that key while an old container can restart
is unsafe. Production and staging use the following coordinated cutover, with
planned downtime for the application:

1. Provision the new KV bundle and its read policy first. Keep the live Agent
   templates and rendered documents unchanged; keep new templates outside the
   Agent's mounted paths until the cutover. Record the previous image digest and
   preserve its non-secret templates and deployment manifests for rollback.
2. Hold automatic CD **before merging** and wait for any running deployment to
   finish. Disable the CD workflow for this operator-managed release, or hold it
   with deployment protection before its manifest-sync step. CD copies templates
   into the Agent's mounted paths, so holding only app startup is too late.
3. Merge, wait for successful CI, and pull the verified immutable release image.
   Keep CD held; the old image and compatible secret document continue serving
   while the new image is prepared.
4. Enter the maintenance window. Suspend scheduled CLI jobs and wait for old jobs
   to finish. Explicitly stop every old-image consumer of the shared document:
   `app` and, when enabled, `app-sandbox`. Use Compose `stop` so
   `restart: unless-stopped` cannot restart them against the new document.
5. With old consumers stopped, install the new deployment manifests and Agent
   templates, then recreate `vault-agent` so it loads the new bind-mounted files.
   Confirm both documents render, the `web-session` bundle has a non-empty
   `client_secret`, and recent authentication
   or renewal is logged. Check without printing secret values, using
   [Checking deployed state](#checking-deployed-state); a running container alone
   is not evidence of authentication.
6. Run migrations with the verified new image and replace the stopped application
   containers with that image. Use `--no-deps` only after the Agent checks above,
   as CD does. Check production and enabled sandbox health, then resume CLI jobs
   and automatic CD for the same release.

For rollback, keep CD and CLI jobs held and stop the new application containers
first. Restore the previous Agent templates and manifests, recreate the Agent,
and confirm it has rendered the old-compatible document **without** the
`web-session` root key before starting the previous image. Rolling back only the
image leaves the old reader unable to boot. Do not delete database data as part
of this secret-document rollback.

The Customer Web BFF client secret authenticates the Web Session route group's
`X-AIHUB-Client-Secret`. Production and staging refuse to boot without its
rendered bundle; missing development/test configuration makes the routes answer
`503` rather than admitting every caller.

The `vault-agent` healthcheck requires all three rendered bundles and a reachable
`metrics_only` listener bound to the Agent container's loopback. This listener
does not add capabilities to the runtime AppRole. Healthcheck output names the
failure without printing metric payloads or credentials. The deployed Agent's
metrics response does not currently include the documented
`vault.agent.authenticated` gauge, so CD verifies that the container is running,
both bundles are present, and an auth or renewal log occurred within the last
hour instead of trusting that false-negative health state.

To inspect the Agent manually, verify all three bundles and that its metrics listener
responds. Compose health alone is not evidence of authentication:

```sh
vault_container_id="$(sudo -n docker compose --env-file .env.production \
  -f docker-compose.production.yml ps -q vault-agent)"
sudo -n docker inspect --format '{{json .State.Health}}' "$vault_container_id"
sudo -n docker exec "$vault_container_id" sh -ec \
  "test -s /run/secrets/aihub/runtime-secrets.json && \
   test -s /run/secrets/aihub/auth-mfa-secrets.json && \
   test -s /run/secrets/aihub/connection-secrets.json && \
   wget -q -T 2 -O /dev/null 'http://127.0.0.1:8220/agent/v1/metrics?format=prometheus'"
```

The command verifies that the metrics listener responds; it does not prove
authentication. A successful `vault status` is not evidence of Agent
authentication; it reports Vault server state. CD uses `--no-deps` for
migrations and app startup only after its direct bundle and recent-auth checks,
so Compose's stale health state cannot block a release. CD never recreates the
Agent; an operator recreates it with the provisioned role ID during the
coordinated cutover.

The migration container is one-shot. Do not run `docker compose down -v`; the
Postgres and Redis data belong to the existing VPS stacks. Back up the existing
`aihub` database before running a new migration set.

## The public edge

nginx on the host terminates TLS for every site on this VPS and proxies AIHUB to
`127.0.0.1:${AIHUB_APP_PORT}` for production and
`127.0.0.1:${AIHUB_SANDBOX_APP_PORT}` for sandbox. This Compose stack publishes
no public port and contains no reverse proxy; an earlier containerized proxy
service never ran here and was removed after it failed a release by trying to
bind port 80 against nginx.

**This VPS is shared.** `/etc/nginx/sites-enabled/` serves eleven sites, most of
them unrelated to AIHUB, and `docker ps` lists around twenty containers from
several projects. Taking port 80 or 443 from nginx takes those sites down with
it. Do not stop nginx, do not add a container that binds those ports, and do not
"free up" a port that appears to be in use. AIHUB owns only
[`ops/nginx/aihub-api.conf`](../../ops/nginx/aihub-api.conf) and
[`ops/nginx/sandbox.conf`](../../ops/nginx/sandbox.conf); the other hostnames
and their Certbot blocks stay operator-managed.

### Managed nginx configuration

The operator-managed `/etc/nginx/conf.d/aihub.conf` retains the apex frontend,
Certbot redirects, and legacy alias. CD manages the API and Sandbox files
`/etc/nginx/conf.d/aihub-api.conf` and `/etc/nginx/conf.d/sandbox.conf`. On a
host being migrated to these managed files, perform this one-time migration
during a supervised change window:

1. Back up `/etc/nginx` and capture current behavior of both AIHUB hosts and at
   least one unrelated site.
2. Copy only the TLS and port-80 `api.aihubproduction.com` server blocks into
   `/etc/nginx/conf.d/aihub-api.conf`. Preserve the frontend/apex blocks,
   Certbot redirects, and `aihub-api.aihubproduction.com` alias in `aihub.conf`.
3. If `nginx -t` reports `aihubproduction.com` or
   `www.aihubproduction.com` conflicting on port 80, inspect the active blocks
   with `sudo nginx -T`. On this VPS, `/etc/nginx/sites-enabled/aihub` was a
   stale HTTP proxy for those names, duplicating the canonical redirects in
   `conf.d/aihub.conf`. Back up the file and disable only that stale port-80
   block after confirming the canonical redirects remain enabled. Do not
   disable the apex TLS/frontend blocks in `conf.d/aihub.conf` or change other
   sites. Stop and investigate if the warning names another host or file.
4. Run `sudo nginx -t`, reload once, then verify apex and `www` HTTP redirect
   to HTTPS, `/health` on both AIHUB hosts,
   `/metrics` and `/ready` return 404, and the unrelated site still works.
   Probe the public grading route without an API key; it must return the app's
   JSON `401` without dispatching to the provider or consuming quota:

   ```sh
   response_file="$(mktemp)"
   status="$(curl -sS -o "$response_file" -w '%{http_code}' -X POST \
     https://api.aihubproduction.com/v1/ielts/speaking/grading)"
   test "$status" = 401
   jq -e 'has("error")' "$response_file" >/dev/null
   rm -f "$response_file"
   ```

   Do not expect this `401` to be gzip-compressed: stock nginx's gzip filter
   only accepts status 200, 403, and 404. CI verifies compressed `200` verdict
   responses and `Vary: Accept-Encoding` using the captured fixture.

5. Prepare the staging directory and install the reviewed helper as root before
   enabling its CD invocation.

Production cleanup completed 2026-10-10: the stale port-80 block in
`/etc/nginx/sites-available/aihub` was disabled; its symlink remains enabled but
contains no server block. The canonical redirects and frontend TLS blocks stay
in `conf.d/aihub.conf`. After reload, `nginx -t` was clean, apex and `www` HTTP
returned 301, and Production, Sandbox, and an unrelated site's HTTPS health
probes returned 200.

```sh
sudo install -d -o <deploy-user> -g <deploy-user> -m 0750 \
  /var/lib/aihub-nginx-staging
sudo install -o root -g root -m 0755 ops/nginx/aihub-nginx-apply \
  /usr/local/sbin/aihub-nginx-apply
```

Add exactly this sudoers command for the deploy user using `visudo`:

```sudoers
<deploy-user> ALL=(root) NOPASSWD: /usr/local/sbin/aihub-nginx-apply
```

CD stages the API config and, when `AIHUB_SANDBOX_ENABLED=true`, the Sandbox
config in `/var/lib/aihub-nginx-staging`. The no-argument root-owned helper only
changes those two destinations, runs `nginx -t` before reload, and restores
previous files if install, validation, or reload fails. With Sandbox disabled,
it removes only `/etc/nginx/conf.d/sandbox.conf`. Operators review and install
helper updates; CD cannot replace its code.

Do not enable this CD step until migration and bootstrap are complete. The API
and Sandbox configs keep the 27 MiB request ceiling, 75-second proxy timeouts,
forwarding headers, HSTS, hidden nginx version, and edge 404s for `/metrics`
and `/ready`. Both `Host` and `X-Forwarded-Host` are set from nginx's routed
`$host`; the latter must not pass through caller input because the app resolves
its runtime environment from the hostname.

Speaking gzip is scoped to JSON responses from the two grading routes. The
multipart audio request passes unchanged, and request buffering is disabled
only for raw multipart grading. CI checks the actual nginx locations with the
captured verdict fixture and no provider call. The app sets
`Cache-Control: no-store` on both grading routes for privacy.

The workflow step is gated by the repository Actions variable
`AIHUB_MANAGED_NGINX`. Leave it unset during initial rollout; set it to the
string `true` only after the supervised migration, staging directory, helper,
and sudoers entry have been verified. This lets normal app deployments proceed
while the operator-owned cutover is pending.

### Publishing another hostname

certbot cannot create a server block, only attach a certificate to one that
already exists. Running `certbot --nginx -d <new host>` first obtains the
certificate and then fails to install it:

```
Could not automatically find a matching server block for <new host>.
Set the `server_name` directive to use the Nginx installer.
```

So write the block first, then let certbot fill in the TLS lines — or write
them against the certificate paths certbot reports. The Sandbox block is
versioned in `ops/nginx/sandbox.conf` and installed by the managed helper after
the migration and bootstrap above.

The sequence:

```sh
cp -r /etc/nginx ~/nginx-backup-$(date +%Y%m%d-%H%M%S)   # rollback point
sudo certbot --nginx -d <new host>                        # obtains the cert
sudo nano /etc/nginx/conf.d/<name>.conf                   # write the block
sudo nginx -t && sudo systemctl reload nginx
```

DNS must already point at this VPS or certbot cannot complete the challenge.

Verify afterwards that the new hostname answers **and** that an unrelated site
still does. One reload serves every site on this box.
Setting `AIHUB_SANDBOX_HOST` in `.env.production` only teaches the application
to recognise the hostname; without the nginx block, nothing reaches it. The
sandbox block must point at `AIHUB_SANDBOX_APP_PORT`, never at the production
port, or the data boundary is bypassed at the edge.

Never add a wildcard or default server block. nginx refusing an unknown
hostname is what makes the application's environment binding trustworthy —
`Host` is client-supplied, and the edge serving only names it was given is the
half of that guarantee the application cannot enforce itself.

### Disabling the sandbox tier

Set `AIHUB_SANDBOX_ENABLED=false` and remove `AIHUB_SANDBOX_HOST` and
`AIHUB_SANDBOX_ORG_IDS` together. The next `main` deployment removes the
managed nginx Sandbox file and stale `app-sandbox` container. It does not drop
`aihub_sandbox`; retain that database until its backup and disposal have been
approved separately.

## Verify and operate

### Checking deployed state

`ops/status.sh` reports, for the production and Sandbox containers, the commit
each runs, its state and health, `/health` and `/ready` probes from inside the
container, its restart count, and the number of error-like log lines since it
started. It changes nothing. Nothing is installed on the host; the script
travels over stdin, and the host user needs the same `sudo -n docker` access the
deploy uses:

```sh
ssh <user>@<host> 'bash -s -- <expected-commit-sha>' < ops/status.sh
```

Pass the commit you expect (for example `git rev-parse origin/main`) and a
container on any other commit is reported `FAIL`, so "is the latest code live?"
has a yes-or-no answer. The exit status is 1 when any container is missing, not
running, not healthy, failing either probe, or on another commit. A non-zero
`errors=` count is not a failure by itself: read those lines, because they
include real errors such as a downstream contract violation.

Use an SSH key for this, not a password: a credential pasted into a chat or a
ticket stays in its history.

A container's logs are deleted with the container, and every deploy replaces
it. So before it recreates `app` and `app-sandbox`, the deploy saves what the
running ones logged to `deploy-logs/<service>-<commit>-<time>.log` under the app
directory (mode `700`, the last 20 MB of each, kept 30 days). To read an error
that a later deploy has already removed from `docker logs`, open the file named
for the commit that was running when it happened. Saving is best effort and
never blocks a release.

### Diagnosing unmatched API 404s

A `request_completed` event with `route: "unmatched"` and `http_status: 404`
means Fastify did not match the request to an application route. AIHUB returned
its normal client-facing `NOT_FOUND` response (`outcome: "client_error"`). This
is a route miss, not a failure in a matched handler or a downstream service. A
matched route that returns 404 has its route template in `route` and needs to
be diagnosed against that route. An Nginx-generated 404 does not reach the app
and therefore has no AIHUB `request_completed` event.

The completion event intentionally has no raw path, query, or body. Its Pino
`time` field is a Unix timestamp in milliseconds; use its `method` and
`http_status` to narrow the Nginx access-log entries. The `request_id` is an
AIHUB identifier that Nginx does not share, so it cannot join the two logs.
Production and Sandbox app events come from separate `app` and `app-sandbox`
containers; use the container that emitted the event because an unmatched
request may not have an `environment` field. If that container has already
been replaced, use its retained file under `deploy-logs/` as described above.

The current VPS uses UTC. Nginx's default `combined` access-log format records
time to the nearest second and may include a query in its request field. Copy
the event's numeric `time`, `method`, and `http_status` into these variables;
the conversion drops the milliseconds to match Nginx's timestamp precision:

```sh
event_time_ms=... # numeric `time` from the event
method=...        # `method` from the event
status=...        # `http_status` from the event
second="$(date -u -d "@$((event_time_ms / 1000))" '+%d/%b/%Y:%H:%M:%S')"
```

Run the following read-only search as an operator who can read the access log.
It prints every entry in that second with the same method and status, strips
the query before displaying the path, and does not print the client address or
the raw request line:

```sh
awk -F '"' -v second="$second" -v method="$method" -v expected_status="$status" '
  index($1, "[" second " ") {
    split($2, request, " ")
    path = request[2]
    sub(/\?.*/, "", path)
    logged_status = $3
    sub(/^[[:space:]]*/, "", logged_status)
    sub(/[[:space:]].*/, "", logged_status)
    if (request[1] == method && logged_status == expected_status)
      print request[1], path, logged_status
  }
' /var/log/nginx/access.log
```

The current host config sets the global access log to
`/var/log/nginx/access.log` and does not define a custom log format, so the
default is `combined` unless the API server block overrides it. If the log
format or path has changed, inspect the effective Nginx config with
`sudo nginx -T` and adjust the search accordingly. The access-log file is
restricted; use an account with permission to read it. If several entries
remain, report them as candidates: the event's timestamp, method, and status
cannot identify one request when multiple requests match in the same second.

### Optional request tracing

Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` in `.env.production` to an OTLP/HTTP
traces endpoint reachable from the application container, for example
`http://otel-collector:4318/v1/traces`. AIHUB sends traces to that receiver;
the production Compose stack does not run a collector or trace store. Leave the
value blank to keep instrumentation disabled. `app` and `app-sandbox` use the
same endpoint setting.

Each trace contains a Fastify request span and child spans for ioredis, Postgres,
and Undici downstream calls. The root span records the route template, generated
request ID, method, and response status. Redis arguments, SQL text beyond the
operation name, downstream URL credentials and query values, request bodies,
credentials, and baggage are not exported.
OTLP export is batched asynchronously and is not awaited by the request path.

After changing the endpoint, recreate the app containers:

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml up -d --no-deps app
docker compose --env-file .env.production \
  -f docker-compose.production.yml --profile sandbox up -d --no-deps app-sandbox
```

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  --profile sandbox ps
docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  --profile sandbox logs --tail=100 app app-sandbox vault-agent
```

After migration, production owns the Sandbox Organization and its key and
identity-configuration rows. Usage, idempotency, and dispatch reservations stay
in `aihub_sandbox`. Check the configured Organization IDs in both databases:

```sh
sandbox_org_ids="${AIHUB_SANDBOX_ORG_IDS:?AIHUB_SANDBOX_ORG_IDS is required}"
sudo -n docker exec aihub-db psql -U aihub_admin -d aihub \
  -v sandbox_org_ids="$sandbox_org_ids" <<'SQL'
SELECT id,
       (SELECT count(*) FROM api_keys WHERE organization_id = o.id) AS api_keys,
       (SELECT count(*) FROM organization_identity_configs WHERE organization_id = o.id) AS identity_configs
FROM organizations AS o
WHERE id = ANY(string_to_array(:'sandbox_org_ids', ','));
SQL

sudo -n docker exec aihub-db psql -U aihub_admin -d aihub_sandbox \
  -v sandbox_org_ids="$sandbox_org_ids" <<'SQL'
SELECT 'organizations' AS record, count(*) FROM organizations
  WHERE id = ANY(string_to_array(:'sandbox_org_ids', ','))
UNION ALL SELECT 'api_keys', count(*) FROM api_keys
  WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','))
UNION ALL SELECT 'identity_configs', count(*) FROM organization_identity_configs
  WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','))
UNION ALL SELECT 'usage_records', count(*) FROM usage_records
  WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','))
UNION ALL SELECT 'idempotency_records', count(*) FROM idempotency_records
  WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','))
UNION ALL SELECT 'dispatch_reservations', count(*) FROM sandbox_dispatch_reservations
  WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','));
SQL
```

Expect the control-plane counts for each configured Organization in production,
and zero Organization, key, and identity-configuration rows in Sandbox. Any
Sandbox usage, idempotency, or reservation history remains in the sandbox
database. The production backup includes the migrated control-plane records;
store it with the same restricted access as other production backups.

Use real sandbox and production keys for the final boundary checks: a sandbox
key on the production hostname and a production key on the sandbox hostname
must both be rejected. Dropping `aihub_sandbox` is the destructive test and is
only appropriate on a disposable rehearsal; the production backup above is the
rollback point, not a reason to drop the live database.

Back up the existing Postgres before releases and test restore separately. Rotate Vault
`secret_id` and downstream credentials using the Vault runbook, then restart
`vault-agent` and `app` so the startup snapshot is re-rendered. Certificates are
renewed by certbot on the host, not by this stack.

## AI Speaking Production handoff

The release image contains the authenticated multipart smoke helper. Run it from
the VPS with a real WAV fixture after a deployment; set
`AIHUB_API_KEY_FILE` to a restricted file containing a key for the same tier as
`AIHUB_BASE_URL`. The helper reads that key and the assertion-signing key from
their restricted files, keeps them out of output, and removes its in-container
key copy on exit:

```sh
AIHUB_API_KEY_FILE=/path/to/production-scoped-api-key \
  bash /home/ngoc_anh/speaking-gateway-smoke.sh \
  /home/ngoc_anh/aihub-speaking-contract-probe.wav
```

Expected output is `HTTP_STATUS=200`. The request is sent to
`https://api.aihubproduction.com/v1/ielts/speaking/grading` by default and must
return the normalized `{data, meta}` envelope. Run the same helper with an
explicit `AIHUB_BASE_URL` and a key file scoped to that environment when
validating another tier. The helper has no default API-key path; never send a
Sandbox key to Production.

The Production handoff matrix is split by safety boundary:

- Production smoke covers a successful authenticated multipart request and the
  public validation/authentication/size boundaries (`401`, `400`, and `413`).
- The provider `401`/`4xx`/`5xx`, throttling, timeout/cancellation, and malformed
  success mappings are covered by the Speaking HTTP seam tests; do not corrupt
  live provider credentials or deliberately overload Production to manufacture
  those failures.
- The blue-green helper probes `/health` through every enabled public hostname
  from the VPS once per second while the candidate starts, after cutover, and
  during drain. It does not follow redirects or read response bodies. The helper
  then runs `scripts/ops/probe-runtime-dependencies.cjs` inside the candidate:
  private `/ready` must report runtime and configured control-plane Postgres
  up; Redis is reported but a Redis-only failure is advisory because gateway
  requests fail open. The container must also complete a TCP connection or
  verified TLS handshake to both configured AI service hosts. These probes send
  no HTTP request to either
  provider, so they do not authenticate or exercise grading/model behavior.
  Failures identify the hostname or dependency name and a safe status/code; raw
  response bodies and configured URLs are not logged. Sandbox checks are skipped
  when `AIHUB_SANDBOX_ENABLED=false`. The existing direct Compose release path
  has no automatic rollback. The updated CD workflow uses the blue-green helper
  when re-enabled; until then, use the direct rollback procedure below.

## Rollback

The deployed release still uses the direct Compose history until the first
successful blue-green cutover. Those direct releases record each successful
tier's replaced and deployed commit SHA in
`$APP_DIR/.aihub-deploy-state/direct-releases.tsv` (directory mode `0700`, file
mode `0600`) and adds the same rows to the CD Actions summary. Each row is
`run_id`, UTC time, tier, previous SHA, deployed SHA. A failed CD run may leave
`direct-release-pending.tsv`; it is not successful history. Use the latest
successful run summary and host history together when choosing the last known
good SHA. `.env.production` is the desired image setting, not release history.
The CD workflow is manually disabled. After the blue-green activation gates
pass, its deploy job will call `scripts/ops/blue-green-host.sh`; it will not
rewrite `.env.production` or reset nginx to slot A.

### Pause CD and select the rollback target

From an authenticated GitHub CLI session, stop new CD workflow runs, then wait
for any run already deploying to finish. Disabling a workflow does not cancel a
run already in progress:

```sh
gh workflow disable cd.yml
gh run list --workflow cd.yml --status in_progress
gh workflow list --all
```

Do not change the host while a CD run is applying a release. Verify CD is
disabled, then inspect the last successful rows on the host and its matching
Actions summary. If the current running SHA is the deployed SHA in the latest
successful row, that row's previous SHA is the rollback candidate, provided it
is still known good and its tag exists. If a failed CD run replaced the image
before the history step, use the most recent successful deployed SHA that
differs from the running SHA. After a manual rollback, the restored SHA should
match an earlier deployed row. Never infer the previous SHA from
`.env.production`.

GHCR was checked on 2026-10-09: the private package had 150 tagged versions,
the oldest tagged version was from 2026-09-18, and the current and preceding
commit-SHA image tags were present. This repository has no image cleanup
workflow. The rollback retention floor is two SHA tags: the current release and
its previous successful release. ADR-0064 currently retains every SHA tag; do
not add cleanup that removes this floor. #115 may set a finite depth later, but
it must preserve at least these two releases. Before rollback, verify the
chosen tag is still listed in the private package and locally pullable. Prefer
the previous image already cached on the host. If it is absent, use an operator-managed
`read:packages` credential through `docker login --password-stdin`, pull the
immutable SHA, and log out; never put the token in `.env.production` or a
command argument. The rollback command below checks the local cache and
performs that temporary login only when the target image is absent.

### Roll back the direct Compose release

Use the exact 40-character target SHA selected above. This updates both enabled
tiers to the same image, matching the legacy direct-Compose behavior. It leaves the
expand-only schema in place and never deletes the database volume or runs a
down-migration. In the same Bash session, record `recovery_started=$(date +%s)`
immediately before changing `AIHUB_IMAGE`; once all health and authenticated
probes pass, calculate `recovery_seconds=$(($(date +%s) - recovery_started))`
and save it in the incident notes. This full-tier command is for an incident;
use the Sandbox-only procedure below for a rehearsal so Production keeps
serving its current container.

```bash
set -euo pipefail
# Use the deployment directory configured as VPS_APP_DIR.
: "${APP_DIR:?set APP_DIR to VPS_APP_DIR}"
cd "$APP_DIR"
rollback_sha='PASTE_40_CHARACTER_SHA_HERE'
[[ "$rollback_sha" =~ ^[a-f0-9]{40}$ ]]
rollback_image="ghcr.io/aihub-ecosystem/aihub-be:$rollback_sha"
if ! sudo -n docker image inspect "$rollback_image" >/dev/null 2>&1; then
  read -r -p 'GHCR username: ' GHCR_USERNAME
  read -r -s -p 'GHCR read:packages token: ' GHCR_PULL_TOKEN
  printf '\n'
  if ! printf '%s' "$GHCR_PULL_TOKEN" | sudo -n docker login ghcr.io \
    --username "$GHCR_USERNAME" --password-stdin; then
    unset GHCR_PULL_TOKEN
    exit 1
  fi
  pull_status=0
  sudo -n docker pull "$rollback_image" || pull_status=$?
  sudo -n docker logout ghcr.io >/dev/null 2>&1 || true
  unset GHCR_PULL_TOKEN
  test "$pull_status" -eq 0
fi
env_tmp="$(mktemp .env.production.rollback.XXXXXX)"
awk '!/^AIHUB_IMAGE=/' .env.production >"$env_tmp"
printf 'AIHUB_IMAGE=%s\n' "$rollback_image" >>"$env_tmp"
chmod 600 "$env_tmp"
mv "$env_tmp" .env.production
compose=(sudo -n docker compose --env-file .env.production -f docker-compose.production.yml)
services=(app)
if grep -qx 'AIHUB_SANDBOX_ENABLED=true' .env.production; then
  compose+=(--profile sandbox)
  services+=(app-sandbox)
fi
"${compose[@]}" up -d --no-deps --no-build "${services[@]}"

for service in "${services[@]}"; do
  container_id="$("${compose[@]}" ps -q "$service")"
  health=starting
  for attempt in $(seq 1 45); do
    health="$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$container_id")"
    [ "$health" = healthy ] && break
    [ "$health" != unhealthy ] || break
    sleep 2
  done
  test "$health" = healthy
  revision="$(sudo -n docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container_id")"
  test "$revision" = "$rollback_sha"
  sudo -n docker exec "$container_id" node scripts/ops/probe-runtime-dependencies.cjs
done

AIHUB_PRODUCTION_HOST="$(sed -n 's/^AIHUB_PRODUCTION_HOST=//p' .env.production | tail -n 1)"
AIHUB_SANDBOX_HOST="$(sed -n 's/^AIHUB_SANDBOX_HOST=//p' .env.production | tail -n 1)"
curl --fail --silent --show-error "https://$AIHUB_PRODUCTION_HOST/health" >/dev/null
if grep -qx 'AIHUB_SANDBOX_ENABLED=true' .env.production; then
  curl --fail --silent --show-error "https://$AIHUB_SANDBOX_HOST/health" >/dev/null
fi
```

Wait for every selected service's container health to become `healthy`; verify
the container revision label equals `rollback_sha`, and check the public
`/health` on every enabled hostname. Provision temporary, least-scope API keys
separately for Production and Sandbox with `key:create` from
[`sandbox-provisioning.md`](sandbox-provisioning.md), setting `--envs` to only
the intended tier and recording the issuance under the operator's AIHUB
username. Store each raw key in a mode-`600` file outside the repository. Set
`AIHUB_PRODUCTION_API_KEY_FILE` and, when Sandbox is enabled,
`AIHUB_SANDBOX_API_KEY_FILE` to those separate paths. Never send a Sandbox key
to Production or reuse a Production key on Sandbox.

Use an active Sandbox Organization on the Sandbox allowlist with an active
identity configuration for the Sandbox key. Use an active Production test
Organization with the `speaking` entitlement and no active identity
configuration for the Production key. The Sandbox probe mints a short-lived
credential, so discard the body and print only the HTTP status. The Production
probe sends an empty JSON object to the Speaking JSON route; its request schema
rejects the body with `400` after API key and User Identity authentication but
before downstream dispatch. It proves Production authentication without
calling the AI provider. It still updates the API key's `last_used_at` and
consumes one rate-limit slot.

```bash
probe_auth() {
  (
    set -euo pipefail
    local host="$1" key_file="$2" path="$3" expected="$4" json="$5" identity="${6:-}" dir config body status
    test -r "$key_file"
    dir="$(mktemp -d)"
    chmod 700 "$dir"
    config="$dir/curl.conf"
    body="$dir/body.json"
    trap 'rm -f "$config" "$body"; rmdir "$dir"' EXIT
    printf '%s\n' "$json" >"$body"
    chmod 600 "$body"
    {
      printf 'url = "https://%s%s"\n' "$host" "$path"
      printf 'request = "POST"\n'
      printf 'header = "X-API-Key: %s"\n' "$(cat "$key_file")"
      printf 'header = "Content-Type: application/json"\n'
      if [ -n "$identity" ]; then
        printf 'header = "X-User-Identity: %s"\n' "$identity"
      fi
      printf 'data-binary = "@%s"\n' "$body"
    } >"$config"
    chmod 600 "$config"
    status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --config "$config")"
    printf '%s %s\n' "$host" "$status"
    test "$status" = "$expected"
  )
}

: "${AIHUB_PRODUCTION_API_KEY_FILE:?set to the Production-scoped API key file}"
probe_auth "$AIHUB_PRODUCTION_HOST" "$AIHUB_PRODUCTION_API_KEY_FILE" \
  /v1/ielts/speaking/grading-json 400 '{}' rollback-probe
AIHUB_SANDBOX_HOST="$(sed -n 's/^AIHUB_SANDBOX_HOST=//p' .env.production | tail -n 1)"
AIHUB_SANDBOX_ENABLED="$(sed -n 's/^AIHUB_SANDBOX_ENABLED=//p' .env.production | tail -n 1)"
if [ "$AIHUB_SANDBOX_ENABLED" = true ]; then
  test -n "$AIHUB_SANDBOX_HOST"
  : "${AIHUB_SANDBOX_API_KEY_FILE:?set to the Sandbox-scoped API key file}"
  probe_auth "$AIHUB_SANDBOX_HOST" "$AIHUB_SANDBOX_API_KEY_FILE" \
    /v1/sandbox/assertions 200 '{"user_id":"rollback-probe"}'
fi
```

Use a dedicated test Organization for each key; the Production test
Organization must have no active identity configuration so `rollback-probe` is
accepted as a Declared User ID. Do not use a customer key or the successful
Speaking grading smoke for this rollback check. Revoke both temporary keys and
remove their files after the rehearsal. If either probe does not return its
expected status, keep CD disabled and treat rollback as unconfirmed.
The `/metrics` scrape also exposes unknown queued rows in the fixed
`aihub_email_outbox_queued{kind="unknown"}` series and their oldest age; raw
stored values are never metric labels.

### Sandbox-only rehearsal rollback

Use this variant only after CD is disabled, no deploy run is active, Sandbox
is enabled, and the rollback image passed the registry/cache checks above. It
changes the shared desired `AIHUB_IMAGE` in `.env.production`, but recreates
only `app-sandbox`; the running Production container must keep the same ID and
revision throughout. Run it in the same Bash session as
`probe_auth` above so the recovery timer includes the Production and Sandbox
auth probes. Only rehearse after a normal later release has written a new
stored value in Sandbox. Confirm that
value exists using release-specific evidence without printing payloads or
secrets; do not seed the database manually to simulate a writer release.

```bash
set -euo pipefail
: "${APP_DIR:?set APP_DIR to VPS_APP_DIR}"
: "${AIHUB_PRODUCTION_API_KEY_FILE:?set to the Production-scoped API key file}"
: "${AIHUB_SANDBOX_API_KEY_FILE:?set to the Sandbox-scoped API key file}"
cd "$APP_DIR"
test "$(sed -n 's/^AIHUB_SANDBOX_ENABLED=//p' .env.production | tail -n 1)" = true
rollback_sha='PASTE_40_CHARACTER_SHA_HERE'
[[ "$rollback_sha" =~ ^[a-f0-9]{40}$ ]]
rollback_image="ghcr.io/aihub-ecosystem/aihub-be:$rollback_sha"
sudo -n docker image inspect "$rollback_image" >/dev/null
production_compose=(sudo -n docker compose --env-file .env.production -f docker-compose.production.yml)
sandbox_compose=(sudo -n docker compose --profile sandbox --env-file .env.production -f docker-compose.production.yml)
production_id_before="$("${production_compose[@]}" ps -q app)"
test -n "$production_id_before"
production_sha_before="$(sudo -n docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$production_id_before")"
sandbox_id_before="$("${sandbox_compose[@]}" ps -q app-sandbox)"
test -n "$sandbox_id_before"
sandbox_sha_before="$(sudo -n docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$sandbox_id_before")"
printf 'sandbox_before_sha=%s production_before_sha=%s\n' "$sandbox_sha_before" "$production_sha_before"
recovery_started="$(date +%s)"
env_tmp="$(mktemp .env.production.rollback.XXXXXX)"
trap 'rm -f "$env_tmp"' EXIT
awk '!/^AIHUB_IMAGE=/' .env.production >"$env_tmp"
printf 'AIHUB_IMAGE=%s\n' "$rollback_image" >>"$env_tmp"
chmod 600 "$env_tmp"
mv "$env_tmp" .env.production
trap - EXIT
"${sandbox_compose[@]}" up -d --no-deps --no-build app-sandbox
sandbox_id="$("${sandbox_compose[@]}" ps -q app-sandbox)"
health=starting
for attempt in $(seq 1 45); do
  health="$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$sandbox_id")"
  [ "$health" = healthy ] && break
  [ "$health" != unhealthy ] || break
  sleep 2
done
test "$health" = healthy
sandbox_sha="$(sudo -n docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$sandbox_id")"
test "$sandbox_sha" = "$rollback_sha"
sudo -n docker exec "$sandbox_id" node scripts/ops/probe-runtime-dependencies.cjs
production_id_after="$("${production_compose[@]}" ps -q app)"
test "$production_id_after" = "$production_id_before"
production_sha_after="$(sudo -n docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$production_id_after")"
test "$production_sha_after" = "$production_sha_before"
AIHUB_PRODUCTION_HOST="$(sed -n 's/^AIHUB_PRODUCTION_HOST=//p' .env.production | tail -n 1)"
AIHUB_SANDBOX_HOST="$(sed -n 's/^AIHUB_SANDBOX_HOST=//p' .env.production | tail -n 1)"
curl --fail --silent --show-error "https://$AIHUB_PRODUCTION_HOST/health" >/dev/null
curl --fail --silent --show-error "https://$AIHUB_SANDBOX_HOST/health" >/dev/null
probe_auth "$AIHUB_PRODUCTION_HOST" "$AIHUB_PRODUCTION_API_KEY_FILE" \
  /v1/ielts/speaking/grading-json 400 '{}' rollback-probe
probe_auth "$AIHUB_SANDBOX_HOST" "$AIHUB_SANDBOX_API_KEY_FILE" \
  /v1/sandbox/assertions 200 '{"user_id":"rollback-probe"}'
recovery_seconds="$(($(date +%s) - recovery_started))"
printf 'sandbox_sha=%s production_sha=%s recovery_seconds=%s\n' \
  "$sandbox_sha" "$production_sha_after" "$recovery_seconds"
```

If any command fails, keep CD disabled and do not mark the rehearsal successful.
Record the Sandbox SHA before rollback and the restored SHA in the table below.
Confirm the unknown-value metric and that valid outbox rows continue through the
normal monitoring/dispatch checks without exposing the stored value. After
recording the result, use the fix-forward release procedure in **Resume CD**;
enabling the workflow alone does not replay a missed deploy.
This Sandbox rehearsal does not substitute for the Production authenticated
request described above.

### Resume CD

Keep CD disabled until the release cause is fixed and the rollback target has
passed the health and authenticated probes. Confirm no CD run is active, then
enable the workflow:

```sh
gh run list --workflow cd.yml --status in_progress
gh workflow enable cd.yml
gh workflow list --all
```

If `main` advanced while CD was paused, do not assume enabling replays a missed
`workflow_run` event. Verify the latest successful CI run for `main`, then
explicitly rerun that run only after the fix-forward release is ready to deploy.
Follow the CD run through the public probes and the release-history summary.

### Rollback triggers and contract migrations

Start rollback when any release gate fails after deployment: a service fails
its container health check within 90 seconds, an enabled hostname has a failed
`/health` probe during the CD probe window, `/ready` reports Postgres or Redis
down, a deployed container OOMs or its restart count increases, or the
authenticated smoke does not return `200`. Also roll back a reproducible
customer-facing regression when evidence ties it to the release. A downstream
provider outage by itself is not evidence that the app image caused the failure;
confirm provider-independent health and authentication first. If rollback does
not restore those checks, keep CD paused and repair forward.

Ordinary migrations remain expand-only, and #484 adds the two-release rule for
new persisted values plus additive configuration and Vault keys. Before any
approved contract migration, attach a reviewed migration-specific rollback
plan to the release. It must name the tested reverse migration or forward-fix
path, the write/traffic pause, and the database backup to preserve. During a
rollback, pause CD, stop writes as the plan requires, run only that reviewed and
rehearsed migration step, then start the previous image and repeat all probes.
If no safe reverse path was approved, do not run an improvised down-migration or
restore a backup over newer writes; fix forward instead. For strict Vault
bundle changes such as the Web Session key, restore the previous compatible
templates and Agent render before restarting the old image; follow the
[coordinated secret cutover](#release-order-when-a-rollout-adds-a-runtime-secret).

### Rehearsal record

Run one rehearsal against enabled Sandbox during a quiet window. Record UTC
date, the deployed SHA, rollback target SHA, the commands/probes used, and the
elapsed time from starting rollback until health and authenticated probes pass.
Keep Production serving throughout. Do not enable blue-green CD as part of this
rehearsal; it remains gated by #289 and ADR-0085.

| Date (UTC) | Sandbox SHA before                       | SHA restored                             | Steps and probe results                                                                                                                                                                                                                                                                                                                                                                                                                | Recovery time                                           |
| ---------- | ---------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 2026-10-10 | 00d97c5dd44cc43dcc465ecf8889b7742ff9f22a | f17a570c9381584ecad88ee8604936added3c781 | Sandbox-only rollback; Production container ID and revision stayed unchanged; health/readiness and runtime dependencies passed; Production auth 400, Sandbox auth 200; N-1 unknown-kind metric=1 while password-reset row reached provider_accepted. Fixed forward to 00d97c5; MFA login 200 and unknown-kind metric returned to 0. Fixture setup intentionally held Sandbox stopped for about 6m46 before the rollback timer started. | 9s from changing the image through authenticated probes |

## Approved blue-green rollout target (#224)

This is the accepted target in [ADR-0085](../adr/0085-per-tier-blue-green-cutover.md).
The CD workflow is currently disabled manually. Do not re-enable it until the
implementation, automated Sandbox rollback rehearsal, manual rollback gate in
#289, #284's background-work shutdown fix and lifecycle test, and live-host CPU
limit measurement are complete.

Deploy Production, then Sandbox, one tier at a time. Keep the current tier
serving while one candidate starts from the immutable CI SHA. Require private
`/ready`, switch only that tier's AIHUB nginx upstream through the fixed helper
in [ADR-0079](../adr/0079-managed-nginx-configuration-on-shared-vps.md), and
run #113's public-edge and in-container dependency smoke against the candidate.
Reject a candidate if its OOM state is set or its restart count increases during
startup or smoke; this triggers rollback while the old service is still
available. Confirm rollback with the same dependency smoke on the restored
service. Retain the old service until smoke passes, then wait for Compose's
150-second stop grace. The budget is 60 seconds for HTTP drain, 75 seconds for
background idempotent work, and 5 seconds for telemetry export, with 10 seconds
of margin. This drain is safe only after #284 makes shutdown wait for both
in-flight HTTP requests and background idempotent work before closing clients;
keep CD disabled until that change and its lifecycle test pass. The
validated upstream is the active-slot source of truth; the immutable image SHA
and #289's durable record identify the release. `.env.production` is not the
last-good release record.

Before each deploy, the helper reconciles `AIHUB_SANDBOX_ENABLED` with the
managed Sandbox route. Disabling Sandbox removes and validates the route before
stopping both Sandbox slots, then confirms only Production remains. Enabling it
without a route first confirms Sandbox containers are absent; after the
Production cutover, it starts Sandbox, checks private readiness and dependencies,
adds the route, and checks the public health window. The initial Sandbox release
is recorded as `disabled -> slot A`, so manual rollback can remove the route and
stop Sandbox without looking for a nonexistent previous image.

Timestamped public `/health` results are appended to
`.aihub-deploy-state/edge-probes.tsv`. Labeled resource snapshots in
`.aihub-deploy-state/resources-*.log` include host CPU and memory, Docker CPU
and memory for running containers, and state, OOM flag, and restart count for
AIHUB containers. The helper also saves the inactive slot's last 20 MB of logs
before Compose replaces that container.

Allow at most three AIHUB application containers total, reusing the single
candidate for Sandbox after Production is verified and drained. Roll back only
the tier whose smoke failed. A rollback is confirmed only when nginx validation
and reload succeed and public health plus smoke pass on that tier's hostname.
If confirmation fails, preserve both slots, fail CD, stop subsequent deploys,
and require operator repair through #289. Do not touch other nginx sites or
ports 80/443.

Before enabling CD, rehearse a controlled post-cutover smoke failure and capture
the automatic rollback evidence. During each rollout and its rehearsal, probe
every enabled public hostname's `/health` every second; require no failed probes
and no OOM, and record host/container CPU, memory, and OOM events. The live host
has two vCPUs and shared workloads, so choose CPU limits from measured headroom
with the third container before rollout. A running deployment is not cancelled;
the latest pending release wins.

This automatic window ends after cutover, smoke, drain, and the short final
health check. It does not roll back a later error-rate or latency regression.
Until #237/#240 provide the needed metrics and #292 defines SLO alerts, use
existing alerts and the rehearsed #289 manual rollback for later regressions.

The host helper supports `status`, `rollback production`, `rollback sandbox`,
and `rehearse sandbox`. The rehearsal command deliberately injects a failed
post-cutover smoke and succeeds only when Sandbox is restored and verified; it
does not cut over Production. Use the immutable CI SHA for `AIHUB_IMAGE` when
running it manually. The CD Actions summary reports the active SHA for each
enabled tier after both successful and failed deploy attempts.

After syncing the reviewed helper to the VPS and logging Docker into GHCR, run
the Sandbox rehearsal from the deployment directory:

```bash
cd "$APP_DIR"
APP_DIR="$PWD" AIHUB_IMAGE=ghcr.io/aihub-ecosystem/aihub-be:REPLACE_WITH_40_CHAR_CI_SHA \
  ./scripts/ops/blue-green-host.sh rehearse sandbox
APP_DIR="$PWD" ./scripts/ops/blue-green-host.sh status
```

Only use `rollback <tier>` after that tier has a successful blue-green deploy
record in `releases.tsv`; the direct-Compose history above is not input to this
helper.

## GitHub Actions CD

The `CI` workflow publishes the image it booted to GHCR under the commit sha.
The `CD` workflow is manually disabled. When re-enabled, it resolves the
immutable SHA, checks the registry still holds the digest `CI` published, syncs
the helper and deployment files, then calls the blue-green deploy command over
SSH. The VPS must already be prepared using this runbook, with the Compose files
and `.env.production` in the app directory. The deploy user must be allowed to
run Docker non-interactively, either directly or via passwordless
`sudo -n docker`.

Create a protected GitHub Environment named `production` and add these secrets:

- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_PORT` (optional; defaults to `22`)
- `VPS_APP_DIR`
- `VPS_SSH_PRIVATE_KEY`
- `VPS_SSH_KNOWN_HOSTS` (the trusted host-key line for the VPS)
- `GHCR_USERNAME`
- `GHCR_PULL_TOKEN` (a token with `read:packages` and `write:packages`; the
  main-only image publisher uses it to push, and CD uses it to pull)

Restrict the `production` environment's deployment branches to `main`. The CI
image boot job runs for pull requests without entering this environment; only
the separate publisher job enters it to push the booted image. CD's
`workflow_run` jobs also enter `production`; their workflow runs on the default
branch (`main`), while the trigger and resolve-job condition verify that the
completed CI run itself came from a push to `main`.

The workflow uses the commit SHA as the only release tag; nothing publishes
`latest`, so a rollback remains the immutable-image procedure above pointing at
an earlier SHA. Keep all runtime, database, Vault, and downstream credentials
in the VPS/Vault setup; never add them to GitHub Actions or the repository.

Before any host change, CD fetches `main` and requires the completed CI run's
SHA to still be its tip. It reads the running revision of each enabled tier
from `org.opencontainers.image.revision` and refuses a target that is already
running or older than that revision. To intentionally deploy an older release,
use the deliberate rollback procedure in #289; rerunning an old CI run is not
a rollback mechanism.
