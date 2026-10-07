# Customer Sandbox control-plane cutover procedures (issues #50 and #182, ADR-0056)

> **Historical record.** Both cutovers ran in production: #50 moved the Sandbox
> rows out of the production control plane, and #182 moved the Organization,
> API-key, and identity-configuration rows back into it. The `pnpm
migrate:sandbox-control-plane` tool that performed the #182 move was removed in
> #337, so the commands below no longer exist; git history retains the tool.
> Keep this document for the record of what was executed and why, not as
> something to re-run. ADR-0056 holds the decision that survives.

The two procedures below are preserved in the order they ran.

## Procedure #50: sandbox database cutover

> **Do not repeat this procedure for #182.** ADR-0056 records the approved
> target: move sandbox Organization, API-key, and identity-configuration rows
> back into the production control-plane database, while retaining sandbox
> usage, idempotency, and dispatch reservations in `aihub_sandbox`. This
> section documents the historical #50 cutover only; follow
> [Procedure #182](#procedure-182-control-plane-migration) for the
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

## Procedure #182: control-plane migration

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
