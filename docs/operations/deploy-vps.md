# VPS deployment

This is the production baseline for the single-node Compose deployment. It uses
the existing production `aihub-db` and Wispace Redis, and renders downstream
runtime credentials through Vault Agent. When sandbox isolation is enabled,
`app-sandbox` is a second container from the same image, backed by
`aihub_sandbox` and Redis logical database `/1`.

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
- An isolated sandbox also needs `AIHUB_SANDBOX_DATABASE_URL`,
  `AIHUB_SANDBOX_REDIS_URL` (logical database `/1`), and
  `AIHUB_SANDBOX_APP_PORT` (default `3022`). Set all three together; leave all
  three blank when this deployment does not serve sandbox.
- The existing Docker network `aihub_aihub-network` with a healthy `aihub-db` container.
- A production Vault AppRole whose policy can read only
  `secret/data/aihub/production/*` (required for the future Vault mode; the
  temporary Stage A override below does not use it).
- An operator Vault session that can read the existing Wispace Redis bundle at
  `secret/wispace-bots/messenger/prd`.
- A CA file trusted by Vault, plus the AppRole `role_id` and one-use `secret_id`
  (Vault mode only).
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

Set real hostnames, database password, Vault address and file paths in
`.env.production`. In Vault-backed mode, the template supplies
`DOWNSTREAM_AI_WRITING_TOKEN`, Speaking credentials, and SeaweedFS credentials at
runtime; do not put those values in `.env.production`. The temporary Stage A
exception is documented below. The shared Redis password is the one exception
in the Vault baseline: render only `REDIS_URL` into the mode-600 deployment file
from the operator Vault session below.

`AIHUB_PRODUCTION_HOST` is the only required host setting. Setting
`AIHUB_SANDBOX_HOST` tells the application to recognise that hostname; it does
not publish it. An isolated sandbox additionally requires its own database and
Redis URLs; the Compose profile is only started when all three sandbox settings
are present. Serving the hostname is a separate nginx change described in
[The public edge](#the-public-edge). Leaving the sandbox settings blank keeps
the sandbox host and container absent.

Point the gateway at the existing production database over the shared Docker
network. The password must be URL-encoded inside `DATABASE_URL` (for example,
`@` becomes `%40`):

```text
DATABASE_URL=postgresql://aihub_admin:<url-encoded-db-password>@aihub-db:5432/aihub
AIHUB_DATABASE_NETWORK=aihub_aihub-network
```

When sandbox is enabled, use the same Postgres instance and Redis host with a
different database/logical index:

```text
AIHUB_SANDBOX_APP_PORT=3022
AIHUB_SANDBOX_DATABASE_URL=postgresql://aihub_admin:<url-encoded-db-password>@aihub-db:5432/aihub_sandbox
AIHUB_SANDBOX_REDIS_URL=redis://:<same-redis-password>@redis.aihubproduction.com:6379/1
```

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

Use the existing production Wispace Redis without printing its credential:

```sh
set -eu
redis_host="redis.aihubproduction.com"
redis_port="6379"
redis_password="$(vault kv get -field=REDIS_PASSWORD secret/wispace-bots/messenger/prd)"
redis_url="redis://:${redis_password}@${redis_host}:${redis_port}/0"
tmp_env="$(mktemp)"
grep -v '^REDIS_URL=' .env.production > "$tmp_env"
printf 'REDIS_URL=%s\n' "$redis_url" >> "$tmp_env"
chmod 600 "$tmp_env"
mv "$tmp_env" .env.production
unset redis_host redis_port redis_password redis_url tmp_env
```

The production Redis endpoint is `redis.aihubproduction.com:6379`; verify that
the VPS firewall permits the Redis protocol before starting the gateway. Do not
grant the AIHUB runtime AppRole access to the `wispace-bots` path; the operator
copies only the required password into `.env.production`. Redis `/1` is not a
durable isolation boundary: it keeps sandbox counters/cache keys out of the
production logical database, while Postgres remains the durable boundary.

## Create and cut over the sandbox database

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
  -f docker-compose.production.yml -f docker-compose.production.env.yml)
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

## Temporary Stage A env mode

Until the Vault adoption trigger in issue #30 is met, use the explicit Compose
override `docker-compose.production.env.yml`. It removes the Vault Agent
dependency and passes the downstream credentials from the mode-600
`.env.production` file to the app and migration containers.

Set these values in `.env.production` without committing or printing them:

```text
AIHUB_RUNTIME_SECRET_SOURCE=env
AIHUB_ALLOW_PRODUCTION_ENV_SECRETS=true
DOWNSTREAM_AI_WRITING_TOKEN=<real-token>
DOWNSTREAM_AI_SPEAKING_CLIENT_ID=<real-client-id>
DOWNSTREAM_AI_SPEAKING_SECRET_KEY=<real-secret-key>
SEAWEEDFS_ACCESS_KEY_ID=<seaweedfs-access-key>
SEAWEEDFS_SECRET_ACCESS_KEY=<seaweedfs-secret-key>
```

Validate and start the temporary stack:

```sh
sudo -n docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  -f docker-compose.production.env.yml config --quiet
sudo -n docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  -f docker-compose.production.env.yml pull app
sudo -n docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  -f docker-compose.production.env.yml --profile migration run --rm migrate
sudo -n docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  -f docker-compose.production.env.yml up -d --no-build app
```

For an isolated sandbox, set the three sandbox connection settings and run both
migrations and both containers in the same Compose project:

```sh
compose=(sudo -n docker compose --env-file .env.production \
  -f docker-compose.production.yml -f docker-compose.production.env.yml)
"${compose[@]}" --profile sandbox pull app app-sandbox
"${compose[@]}" --profile migration run --rm migrate
"${compose[@]}" --profile migration --profile sandbox run --rm migrate-sandbox
"${compose[@]}" --profile sandbox up -d --no-build app app-sandbox
"${compose[@]}" --profile sandbox ps
```

The CD workflow runs the same sequence and waits for both health checks. A
partial sandbox configuration is rejected rather than starting a hostname whose
container has no isolated database.

This is a deliberate temporary exception: keep `.env.production` at mode 600,
rotate the long-lived provider credentials after Vault cutover, and remove the
override from the CD command when `agent-file` is ready.

## Provision production Vault data (future)

Use the repository helper with the production operator workflow. It writes only the
three production KV paths and never prints secret values:

```sh
AIHUB_VAULT_PROVISION_ALLOW=true \
AIHUB_VAULT_ENVIRONMENT=production \
AIHUB_VAULT_CREDENTIALS_DIR=/secure/aihub/production \
  node ops/vault/provision-runtime-secrets.mjs
```

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

## Start the Vault-backed stack (future)

Validate interpolation first; this does not start containers:

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml config --quiet
```

Build or pull the release, start dependencies and Vault Agent, run migrations once,
then start the app:

```sh
docker compose --env-file .env.production -f docker-compose.production.yml build app
docker compose --env-file .env.production -f docker-compose.production.yml up -d vault-agent
docker compose --env-file .env.production -f docker-compose.production.yml --profile migration run --rm migrate
docker compose --env-file .env.production -f docker-compose.production.yml up -d app
# Replace api.example.com with AIHUB_PRODUCTION_HOST from .env.production.
curl --fail https://api.example.com/health
```

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

## Verify and operate

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml -f docker-compose.production.env.yml \
  --profile sandbox ps
docker compose --env-file .env.production \
  -f docker-compose.production.yml -f docker-compose.production.env.yml \
  --profile sandbox logs --tail=100 app app-sandbox vault-agent
```

The production database must contain no sandbox rows after cutover:

```sh
sandbox_org_ids="${AIHUB_SANDBOX_ORG_IDS:?AIHUB_SANDBOX_ORG_IDS is required}"
remaining="$(sudo -n docker exec aihub-db psql -U aihub_admin -d aihub -At \
  -v sandbox_org_ids="$sandbox_org_ids" -c "
    SELECT count(*) FROM organizations
      WHERE id = ANY(string_to_array(:'sandbox_org_ids', ','))
    UNION ALL
    SELECT count(*) FROM api_keys
      WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','))
    UNION ALL
    SELECT count(*) FROM usage_records
      WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','));")"
test "$(printf '%s\n' "$remaining" | awk '{sum += $1} END {print sum + 0}')" -eq 0
```

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
