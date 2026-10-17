# Control-plane database

The control-plane schema is described twice, on purpose: `prisma/schema.prisma`
is the shape, and `prisma/migrations/<name>/migration.sql` builds a database.
They are two copies of one thing, so `pnpm check:prisma-drift` proves they still
agree, and a renamed column becomes a compile error in the repository that uses
it rather than a surprise at runtime. See
[ADR-0088](adr/0088-prisma-for-control-plane-persistence.md).

The migration files use Prisma's standard directory layout and are configured
in `prisma.config.ts`. `pnpm migrate` still applies them through the existing
runner and `schema_migrations` table; each directory name maps to the existing
`<name>.sql` history key. This keeps Production and Sandbox history intact and
needs no baseline. Do not use `prisma migrate deploy`: it would use a separate
`_prisma_migrations` history. The Prisma CLI remains outside the runtime image
and migration container. `@prisma/client` lists the CLI as an optional peer, so
`.pnpmfile.cjs` drops that peer; `pnpm why prisma --prod` prints nothing, and a
dependency bump that changes the answer shows up in `pnpm-lock.yaml`.

## Database test lane ownership

`pnpm test:db` and `pnpm test:tenant-isolation` use the local services from
`docker-compose.yml` by default: PostgreSQL at
`postgres://aihub:change-me@localhost:5432/aihub`, Redis database 14 at
`redis://127.0.0.1:6379/14`, and Redis database 15 at
`redis://127.0.0.1:6379/15`. Start them and wait for their ownership
healthchecks with `docker compose up -d --wait postgres redis`.

The PostgreSQL healthcheck marks the default admin database (`aihub`) with
`aihub.test_lane_marker=aihub_db_lane_v1`; lane setup and teardown check that
marker on the database named in `DB_LANE_ADMIN_URL` before creating or dropping
any lane database. The Redis healthcheck writes
`aihub:test-lane:owner=aihub-db-lane-v1` to database 0; each test-suite
`FLUSHDB` checks it first. The marker stays outside Redis databases 14 and 15.
Missing or unreadable markers make the lane stop and name the URL setting that
needs correction.

`DB_LANE_ADMIN_URL`, `SANDBOX_TEST_REDIS_URL`, and
`TENANT_ISOLATION_REDIS_URL` can point to another dedicated throwaway service.
The PostgreSQL marker belongs on the database named in `DB_LANE_ADMIN_URL`; the
Redis marker belongs in database 0. Only add them after confirming each server
is dedicated to this lane; do not mark a shared service.

## Changing the schema

1. Edit `prisma/schema.prisma`. Model and field names are the TypeScript names
   the repositories already use; `@map` and `@@map` keep the physical column and
   table names.

2. Bring a database to the current migration state and generate the SQL:

   ```bash
   pnpm migrate
   DATABASE_URL=postgres://aihub:change-me@localhost:5432/aihub \
     pnpm generate:migration add_your_change
   ```

   The command writes
   `prisma/migrations/<next number>_add_your_change/migration.sql`. It refuses
   to write when the schema and the database already agree, because a
   migration with no statements is a mistake, not a no-op.

3. Review the generated file and hand-edit it. Generation removes the second
   hand-maintained copy of the schema, not the review. This is where you add the
   objects the schema language cannot declare — `CHECK` constraints, triggers —
   and note the migration in the model's `///` comment so the next reader knows
   where to change them.

4. Apply and verify:

   ```bash
   pnpm migrate
   pnpm check:migrations      # expand-only contract, unchanged by this workflow
   pnpm check:prisma-drift    # the schema and the history still agree
   ```

`pnpm check:migrations` enforces the expand-only rules, so a generated file that
drops or renames a column still fails. Use its documented hatch only for a
genuine contract migration.

The runner records migration keys as `<directory name>.sql` to preserve the
existing `schema_migrations` rows. Keep a migration directory's name stable
after it has been applied.

`pnpm check:prisma-drift` uses Prisma's `--from-migrations` diff against a
throwaway shadow database. It reads `AIHUB_DRIFT_CHECK_DATABASE_URL` and
`AIHUB_DRIFT_CHECK_SHADOW_DATABASE_URL` only for that check; client generation
and the application build need no database.

## Expand-only migration contract

The runner applies `prisma/migrations/<name>/migration.sql` in directory-name
order. During rolling deploys, two application versions can use the same
schema, so `pnpm check:migrations` enforces this contract in `pnpm verify` and
CI:

```text
PERMITTED:  CREATE TABLE, ADD nullable column, CREATE INDEX CONCURRENTLY
FORBIDDEN:  DROP COLUMN, RENAME COLUMN, ADD ... NOT NULL without DEFAULT
```

`ADD COLUMN ... NOT NULL DEFAULT` is permitted because PostgreSQL backfills the
existing rows in the same statement.

The check strips SQL comments and splits semicolon-terminated statements. It
reports a `directory/migration.sql:line`, the statement, the violation kind,
and the expand/contract alternative. It checks only three patterns, not all
possible destructive changes.

For a genuine contract migration, first ship the additive replacement and
backfill, switch readers, then deploy the destructive cleanup separately days
later. Add a matching marker at the top of that migration, with its reason and
approving issue:

```sql
-- expand-contract: allow-drop-column — reason: old field fully replaced — approved: #123
-- expand-contract: allow-rename-column — reason: ... — approved: #123
-- expand-contract: allow-add-not-null — reason: ... — approved: #123
```

The marker must match the violation kind; there is no blanket file suppression.
The check does not catch every schema change: review `ALTER TYPE`, table or
constraint drops, type changes, indexes created without `CONCURRENTLY`, views,
triggers, extensions, and `SET NOT NULL` separately. All 36 existing migrations
are checked with no ignore list.

## Regenerating the client

`prisma generate` writes the client to `dist/generated/prisma`, outside `src/`
and outside version control. `pnpm type-check`, `pnpm test`, and `pnpm build`
run it themselves, so a fresh clone and CI never compile against a missing or
stale client. To run it by hand:

```bash
pnpm generate:prisma-client
```

Only infrastructure code may import it, under the `@prisma-client/*` alias.
`pnpm arch-check` reports an import from anywhere else, because Prisma types
never reach application or domain code.

The client lives in `dist/`, so `nest-cli.json` sets `deleteOutDir: false`:
Nest would otherwise empty `dist/` on `pnpm dev` and remove the client it was
about to need. `pnpm build` clears `dist/` itself before it compiles and
generates the client afterwards, so a stale build never survives it.
