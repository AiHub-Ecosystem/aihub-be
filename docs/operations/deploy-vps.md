# VPS deployment

This is the production baseline for the single-node Compose deployment. It keeps
Postgres private, uses the existing private Wispace Redis, renders downstream
runtime credentials through Vault Agent, and terminates public TLS at Caddy.

## Prerequisites

- Docker Engine with the Compose plugin.
- DNS `A/AAAA` for `AIHUB_PRODUCTION_HOST` pointing to this VPS; ports 80 and 443 open.
- A production Vault AppRole whose policy can read only `secret/data/aihub/production/*`.
- An operator Vault session that can read the existing Wispace Redis bundle at
  `secret/wispace-bots/messenger/prd`.
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

Set real hostnames, database password, Vault address and file paths in
`.env.production`. The Vault template supplies `DOWNSTREAM_AI_WRITING_TOKEN`,
Speaking credentials, and SeaweedFS credentials at runtime; do not put those values
in `.env.production`. The shared Redis password is the one exception in this
baseline: render only `REDIS_URL` into the mode-600 deployment file from the
operator Vault session below.

Use the existing production Wispace Redis without printing its credential:

```sh
set -eu
redis_host="$(vault kv get -field=REDIS_HOST secret/wispace-bots/messenger/prd)"
redis_port="$(vault kv get -field=REDIS_PORT secret/wispace-bots/messenger/prd)"
redis_password="$(vault kv get -field=REDIS_PASSWORD secret/wispace-bots/messenger/prd)"
redis_url="redis://:${redis_password}@${redis_host}:${redis_port}/0"
tmp_env="$(mktemp)"
grep -v '^REDIS_URL=' .env.production > "$tmp_env"
printf 'REDIS_URL=%s\n' "$redis_url" >> "$tmp_env"
chmod 600 "$tmp_env"
mv "$tmp_env" .env.production
unset redis_host redis_port redis_password redis_url tmp_env
```

The source bundle currently resolves to the private endpoint `172.24.0.1:6379`;
the AIHUB container must run on the same VPS/network boundary. Do not grant the
AIHUB runtime AppRole access to the `wispace-bots` path; the operator copies only
the required connection into `.env.production`.

## Provision production Vault data

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

## Start the stack

Validate interpolation first; this does not start containers:

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml config --quiet
```

Build or pull the release, start dependencies and Vault Agent, run migrations once,
then start the app and Caddy:

```sh
docker compose --env-file .env.production -f docker-compose.production.yml build app
docker compose --env-file .env.production -f docker-compose.production.yml up -d postgres vault-agent
docker compose --env-file .env.production -f docker-compose.production.yml --profile migration run --rm migrate
docker compose --env-file .env.production -f docker-compose.production.yml up -d app caddy
# Replace api.example.com with AIHUB_PRODUCTION_HOST from .env.production.
curl --fail https://api.example.com/health
```

The migration container is one-shot. Do not run `docker compose down -v`; the
Postgres named volume contains durable data. Redis is managed by the Wispace stack,
so coordinate Redis maintenance and backups with that owner.

## Verify and operate

```sh
docker compose --env-file .env.production -f docker-compose.production.yml ps
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=100 app vault-agent caddy
```

Back up Postgres before releases and test restore separately. Rotate Vault
`secret_id` and downstream credentials using the Vault runbook, then restart
`vault-agent` and `app` so the startup snapshot is re-rendered. Caddy renews ACME
certificates automatically while ports 80/443 remain reachable.

## Rollback

Set `AIHUB_IMAGE` to the previous immutable image tag, run
`docker compose ... up -d app`, and verify `/health` plus one authenticated staging request before reopening
traffic. Never roll back by deleting the database volume.
