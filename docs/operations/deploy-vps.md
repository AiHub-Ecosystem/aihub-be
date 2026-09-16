# VPS deployment

This is the production baseline for the single-node Compose deployment. It uses
the existing production `aihub-db` and Wispace Redis, renders downstream runtime
credentials through Vault Agent, and terminates public TLS at Caddy.

## Prerequisites

- Docker Engine with the Compose plugin.
- DNS `A/AAAA` for `AIHUB_PRODUCTION_HOST` pointing to this VPS; ports 80 and 443 open.
- Add DNS for `AIHUB_SANDBOX_HOST` when it is configured. Leave an unused tier
  blank; blank tiers are not bound, and this production Caddy serves only the
  configured production and sandbox hosts.
- An existing reverse proxy may use `AIHUB_APP_PORT` (default `3021`) as its upstream.
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

`AIHUB_PRODUCTION_HOST` is the only required host setting. The optional
`AIHUB_SANDBOX_HOST` is an explicit addition to the Caddy site list, so Caddy
never uses a wildcard or catch-all certificate. If it is set, point its DNS
record at this VPS before starting the stack; leaving it blank keeps the
sandbox host unbound.

Point the gateway at the existing production database over the shared Docker
network. The password must be URL-encoded inside `DATABASE_URL` (for example,
`@` becomes `%40`):

```text
DATABASE_URL=postgresql://aihub_admin:<url-encoded-db-password>@aihub-db:5432/aihub
AIHUB_DATABASE_NETWORK=aihub_aihub-network
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
copies only the required password into `.env.production`.

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
  -f docker-compose.production.env.yml --profile migration run --rm --no-build migrate
sudo -n docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  -f docker-compose.production.env.yml up -d --no-build app caddy
```

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
then start the app and Caddy:

```sh
docker compose --env-file .env.production -f docker-compose.production.yml build app
docker compose --env-file .env.production -f docker-compose.production.yml up -d vault-agent
docker compose --env-file .env.production -f docker-compose.production.yml --profile migration run --rm migrate
docker compose --env-file .env.production -f docker-compose.production.yml up -d app caddy
# Replace api.example.com with AIHUB_PRODUCTION_HOST from .env.production.
curl --fail https://api.example.com/health
```

The migration container is one-shot. Do not run `docker compose down -v`; the
Postgres and Redis data belong to the existing VPS stacks. Back up the existing
`aihub` database before running a new migration set.

## Verify and operate

```sh
docker compose --env-file .env.production -f docker-compose.production.yml ps
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=100 app vault-agent caddy
```

Back up the existing Postgres before releases and test restore separately. Rotate Vault
`secret_id` and downstream credentials using the Vault runbook, then restart
`vault-agent` and `app` so the startup snapshot is re-rendered. Caddy renews ACME
certificates automatically while ports 80/443 remain reachable.

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
`docker compose ... up -d app caddy`, and verify `/health` plus one authenticated request before reopening
traffic. Never roll back by deleting the database volume.

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
