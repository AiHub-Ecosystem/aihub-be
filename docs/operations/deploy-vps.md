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
sudo install -m 0600 -o 10001 -g 10001 vault-secret-id /srv/aihub/secrets/vault-secret-id
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
node scripts/upload-speaking-audio.mjs --source E:\audios
Remove-Item Env:\SEAWEEDFS_ACCESS_KEY_ID, Env:\SEAWEEDFS_SECRET_ACCESS_KEY
```

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

## Existing #50 sandbox database cutover (pre-#182)

> **Do not repeat this procedure for #182.** ADR-0056 records the approved
> target: move sandbox Organization, API-key, and identity-configuration rows
> back into the production control-plane database, while retaining sandbox
> usage, idempotency, and dispatch reservations in `aihub_sandbox`. This
> section documents the historical #50 cutover only; follow [Customer Sandbox
> control-plane migration](#customer-sandbox-control-plane-migration) for the
> current layout.

Run this once before starting the `sandbox` Compose profile. The procedure keeps
the existing sandbox organization, identity configuration, API keys, usage, and
idempotency evidence, then removes those rows from production. It deliberately
stops the production gateway during the copy so no request can write one side
while the other is being cut over.

Back up production first and keep the dump until both smoke checks pass:

```sh
set -eu
backup_dir="$HOME/aihub-backups"
install -d -m 700 "$backup_dir"
backup_file="$backup_dir/aihub-$(date +%Y%m%d-%H%M%S).dump"
sudo -n docker exec aihub-db pg_dump -U aihub_admin -d aihub -Fc >"$backup_file"
chmod 600 "$backup_file"
test -s "$backup_file"
```

Create the database in the existing Postgres container, then run both schema
migrations. `AIHUB_SANDBOX_ORG_IDS` must be the comma-separated allowlist already
used by the sandbox assertion route:

```sh
sudo -n docker exec aihub-db psql -U aihub_admin -d postgres \
  -v ON_ERROR_STOP=1 \
  -c "SELECT 'CREATE DATABASE aihub_sandbox OWNER aihub_admin' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'aihub_sandbox')\\gexec"

compose=(sudo -n docker compose --env-file .env.production \
  -f docker-compose.production.yml)
"${compose[@]}" --profile migration --profile sandbox run --rm migrate-sandbox
```

Freeze gateway writes before copying the current control-plane data. The plain
SQL dump is piped directly between the database container and never written to
the repository or shell history:

```sh
"${compose[@]}" stop app
# Stop any other service that still connects to the production `aihub` database
# (the shared VPS may have a legacy backend outside this Compose project).
sudo -n docker stop <other-aihub-writer>
sudo -n docker exec aihub-db psql -U aihub_admin -d postgres -Atc \
  "SELECT count(*) FROM pg_stat_activity WHERE datname = 'aihub' AND client_addr IS NOT NULL"
set -o pipefail
sudo -n docker exec aihub-db pg_dump -U aihub_admin -d aihub \
  --data-only --no-owner --no-privileges --column-inserts \
  -t organizations -t organization_identity_configs -t api_keys \
  -t usage_records -t idempotency_records \
  | sudo -n docker exec -i aihub-db psql -U aihub_admin -d aihub_sandbox \
      -v ON_ERROR_STOP=1
```

The activity query should show no application clients before the delete
transaction; replace `<other-aihub-writer>` with the actual container name, or
omit that line when no second writer exists. Start every stopped writer again
only after both gateway containers are healthy.

Retain only sandbox organizations in the new database, then remove those same
organizations from production. The delete order follows the foreign keys:

```sh
sandbox_org_ids="${AIHUB_SANDBOX_ORG_IDS:?AIHUB_SANDBOX_ORG_IDS is required}"
sudo -n docker exec -i aihub-db psql -U aihub_admin -d aihub_sandbox \
  -v ON_ERROR_STOP=1 -v sandbox_org_ids="$sandbox_org_ids" <<'SQL'
BEGIN;
CREATE TEMP TABLE sandbox_organizations (id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO sandbox_organizations (id)
SELECT btrim(value)
FROM unnest(string_to_array(:'sandbox_org_ids', ',')) AS input(value)
WHERE btrim(value) <> '';
DELETE FROM idempotency_records WHERE organization_id NOT IN (SELECT id FROM sandbox_organizations);
DELETE FROM usage_records WHERE organization_id NOT IN (SELECT id FROM sandbox_organizations);
DELETE FROM api_keys WHERE organization_id NOT IN (SELECT id FROM sandbox_organizations);
DELETE FROM organization_identity_configs WHERE organization_id NOT IN (SELECT id FROM sandbox_organizations);
DELETE FROM organizations WHERE id NOT IN (SELECT id FROM sandbox_organizations);
COMMIT;
SQL

sudo -n docker exec -i aihub-db psql -U aihub_admin -d aihub \
  -v ON_ERROR_STOP=1 -v sandbox_org_ids="$sandbox_org_ids" <<'SQL'
BEGIN;
CREATE TEMP TABLE sandbox_organizations (id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO sandbox_organizations (id)
SELECT btrim(value)
FROM unnest(string_to_array(:'sandbox_org_ids', ',')) AS input(value)
WHERE btrim(value) <> '';
DELETE FROM idempotency_records WHERE organization_id IN (SELECT id FROM sandbox_organizations);
DELETE FROM usage_records WHERE organization_id IN (SELECT id FROM sandbox_organizations);
DELETE FROM api_keys WHERE organization_id IN (SELECT id FROM sandbox_organizations);
DELETE FROM organization_identity_configs WHERE organization_id IN (SELECT id FROM sandbox_organizations);
DELETE FROM organizations WHERE id IN (SELECT id FROM sandbox_organizations);
COMMIT;
SQL
```

Start both containers only after the cutover. If only one database is migrated,
the other container fails at startup or serves stale identity/schema data; never
run one side against a schema that has not received the same migration set.

## Provision production Vault data

Use the repository helper with the production operator workflow. It writes the
eight production KV paths and never prints secret values:

```sh
AIHUB_VAULT_PROVISION_ALLOW=true \
AIHUB_VAULT_ENVIRONMENT=production \
AIHUB_VAULT_CREDENTIALS_DIR=/secure/aihub/production \
AIHUB_VAULT_AGENT_CIDR=172.16.2.1/32 \
  node ops/vault/provision-runtime-secrets.mjs
```

The directory contains `ai-speaking.json`, `ai-writing.json`, `resend.json`,
`user-access-jwt.json`, `seaweedfs.json`, `database.json`, `redis.json`, and
`sandbox-assertion.json`. Keep it mode `0700` and remove it after provisioning.

`AIHUB_VAULT_AGENT_CIDR` is the address the Vault Agent authenticates from,
read from the deployment's Docker network (the Vault audit log records it as
the request source). Vault only issues a `secret_id` when `bind_secret_id` is
on, and that setting pins the `secret_id` to the requesting address, so the role
is provisioned with the deployment network as `secret_id_bound_cidrs`. Both the
operator and the Agent sit on that network.

Provisioning requires a non-root operator identity. Create/rotate the AppRole
`secret_id` after provisioning, then copy the one-use value to the host. Validate
the policy with the smoke script before starting the application:

```sh
AIHUB_VAULT_SMOKE_ALLOW=true \
AIHUB_VAULT_SMOKE_AUTH_METHOD=approle \
AIHUB_VAULT_ENVIRONMENT=production \
  node scripts/vault-smoke.mjs
```

Run the smoke command from a Vault CLI session authenticated as the generated
non-root AppRole, not as the provisioning operator or a root token.

## Customer Sandbox control-plane migration

Run this once for each configured demo Organization during the #182 cutover.
Back up both databases and stop `app`, `app-sandbox`, and any other writers.
Apply the schema migration to both databases while the applications are
stopped:

```sh
compose=(sudo -n docker compose --env-file .env.production \
  -f docker-compose.production.yml)
"${compose[@]}" --profile migration run --rm migrate
"${compose[@]}" --profile migration --profile sandbox run --rm migrate-sandbox
```

From a workstation checkout over the Postgres SSH tunnel, first inspect the dry
run. `--apply` is required to write; `DATABASE_URL` must point to
`aihub_sandbox` and `CONTROL_PLANE_DATABASE_URL` must point to `aihub`:

```sh
DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:15433/aihub_sandbox' \
CONTROL_PLANE_DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:15433/aihub' \
  pnpm migrate:sandbox-control-plane -- --org org_...

DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:15433/aihub_sandbox' \
CONTROL_PLANE_DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:15433/aihub' \
  pnpm migrate:sandbox-control-plane -- --org org_... --apply
```

The command copies the Organization, keys, and identity configuration to
production, preserves each key ID and hash, and restricts moved keys to the
`sandbox` environment. It deletes only those control-plane rows from Sandbox;
usage and idempotency stay in `aihub_sandbox`, and current-month dispatches are
included in the durable quota reservations. It refuses Organizations with
membership, invitation, or audit records. The dry run reports how many
current-month historical dispatches would seed the durable allowance; it
conservatively includes legacy downstream errors without reservation evidence
because their dispatch status cannot be reconstructed. Review that count and
rerun the command after applying before starting the applications below. Do
not drop `aihub_sandbox`.

## Start the Vault-backed stack

Validate interpolation first; this does not start containers:

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml config --quiet
```

Before a rollout that changes the Vault Agent configuration or healthcheck,
manually create and stage a fresh one-use AppRole SecretID. Compose recreates
the Agent when its service configuration changes, and the existing SecretID
has already been consumed. CD does not issue SecretIDs.

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

The `vault-agent` healthcheck requires both rendered bundles and the live
`vault.agent.authenticated` gauge to equal `1`. The gauge is exposed through an
unauthenticated `metrics_only` listener bound to the Agent container's loopback;
it does not add capabilities to the runtime AppRole. Healthcheck output names
the failure without printing metric payloads or credentials.

To confirm a live session manually, check the Compose health state and its
diagnostic output, then verify both files and the gauge:

```sh
vault_container_id="$(sudo -n docker compose --env-file .env.production \
  -f docker-compose.production.yml ps -q vault-agent)"
sudo -n docker inspect --format '{{json .State.Health}}' "$vault_container_id"
sudo -n docker exec "$vault_container_id" sh -ec \
  "test -s /run/secrets/aihub/runtime-secrets.json && \
   test -s /run/secrets/aihub/connection-secrets.json && \
   wget -q -T 2 -O - 'http://127.0.0.1:8220/agent/v1/metrics?format=prometheus' | \
   grep -E '^vault_agent_authenticated([[:space:]]|[{][^}]*[}][[:space:]])+1([.]0+)?([[:space:]]|$)'"
```

The last command prints only the authenticated gauge line. A successful
`vault status` is not evidence of Agent authentication; it reports Vault server
state. The CD workflow keeps its 60-second health wait and authentication-log
guard, so a healthy Agent does not add deploy delay.

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
"free up" a port that appears to be in use.

The live production site lives in `/etc/nginx/conf.d/aihub.conf`:

```nginx
server_name api.aihubproduction.com;

# Keep the edge above the application's own limits so AIHUB's JSON error
# envelope, not nginx's bare HTML 413/504, reaches the client. The Speaking
# multipart route accepts a 26 MiB wire body and runs on a 60-second budget.
client_max_body_size 27m;
proxy_read_timeout 75s;
proxy_send_timeout 75s;

location / {
    proxy_pass http://127.0.0.1:3021;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

listen 443 ssl; # managed by Certbot
ssl_certificate /etc/letsencrypt/live/api.aihubproduction.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/api.aihubproduction.com/privkey.pem;
```

`proxy_set_header Host $host` is load-bearing. The application resolves the
request environment from that header, so a block that rewrites or drops it would
make every request on that hostname fail with `ENVIRONMENT_NOT_ALLOWED`.

`client_max_body_size` and the proxy timeouts must stay above the application's
own per-operation limits (`maxBodyBytes` and `timeoutMs` in
`src/catalog/operation-catalog.ts`); the sandbox server block needs the same
lines. Without them, nginx rejects a large Speaking upload with its default 1 MB
body limit and a bare HTML 413 before the application ever sees the request, so
the client loses the JSON `PAYLOAD_TOO_LARGE` envelope.

### Publishing another hostname

certbot cannot create a server block, only attach a certificate to one that
already exists. Running `certbot --nginx -d <new host>` first obtains the
certificate and then fails to install it:

```
Could not automatically find a matching server block for <new host>.
Set the `server_name` directive to use the Nginx installer.
```

So write the block first, then let certbot fill in the TLS lines — or write
them yourself against the certificate paths certbot reports. The sandbox tier
was published this way, and `/etc/nginx/conf.d/sandbox.conf` is the result:

```nginx
server {
    server_name sandbox.aihubproduction.com;
    client_max_body_size 27m;

    location / {
        proxy_pass http://127.0.0.1:3022;
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/sandbox.aihubproduction.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sandbox.aihubproduction.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    server_name sandbox.aihubproduction.com;
    return 301 https://$host$request_uri;
}
```

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

Remove the sandbox nginx server block first, validate, and reload nginx so the
hostname stops accepting traffic:

```sh
sudo nano /etc/nginx/conf.d/sandbox.conf
sudo nginx -t && sudo systemctl reload nginx
```

Then set `AIHUB_SANDBOX_ENABLED=false` and remove `AIHUB_SANDBOX_HOST` and
`AIHUB_SANDBOX_ORG_IDS` together. The next `main` deployment removes the stale
`app-sandbox` container. It does not drop `aihub_sandbox`; retain that database
until its backup and disposal have been approved separately.

## Verify and operate

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
the VPS with a real WAV fixture after a deployment; the helper reads the
temporary test API key and assertion-signing key from their restricted files,
keeps them out of output, and removes its in-container key copy on exit:

```sh
bash /home/ngoc_anh/speaking-gateway-smoke.sh \
  /home/ngoc_anh/aihub-speaking-contract-probe.wav
```

Expected output is `HTTP_STATUS=200`. The request is sent to
`https://api.aihubproduction.com/v1/ielts/speaking/grading` by default and must
return the normalized `{data, meta}` envelope. Run the same helper with an
explicit `AIHUB_BASE_URL` when validating another environment.

The Production handoff matrix is split by safety boundary:

- Production smoke covers a successful authenticated multipart request and the
  public validation/authentication/size boundaries (`401`, `400`, and `413`).
- The provider `401`/`4xx`/`5xx`, throttling, timeout/cancellation, and malformed
  success mappings are covered by the Speaking HTTP seam tests; do not corrupt
  live provider credentials or deliberately overload Production to manufacture
  those failures.
- Health is checked by the Compose container healthcheck and the CD workflow;
  rollback uses the immutable `AIHUB_IMAGE` tag described below.

## Rollback

Set `AIHUB_IMAGE` to the previous immutable image tag, run
`docker compose ... up -d app`, and verify `/health` plus one authenticated
request before reopening traffic. Never roll back by deleting the database volume.

## GitHub Actions CD

The `CD` workflow publishes the tested `main` commit to GHCR, then deploys that
immutable image over SSH after `CI` succeeds. The VPS must already be prepared
using this runbook, with the Compose files and `.env.production` in the app
directory. The deploy user must be allowed to run Docker non-interactively,
either directly or via passwordless `sudo -n docker`.

Create a protected GitHub Environment named `production` and add these secrets:

- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_PORT` (optional; defaults to `22`)
- `VPS_APP_DIR`
- `VPS_SSH_PRIVATE_KEY`
- `VPS_SSH_KNOWN_HOSTS` (the trusted host-key line for the VPS)
- `GHCR_USERNAME`
- `GHCR_PULL_TOKEN` (a read-only token with `read:packages`)

The workflow uses the commit SHA as the release tag and also updates `latest`.
The SHA tag is what the VPS deploys, so rollback remains the immutable-image
procedure above. Keep all runtime, database, Vault, and downstream credentials
in the VPS/Vault setup; never add them to GitHub Actions or the repository.
