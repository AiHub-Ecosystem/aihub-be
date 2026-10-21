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

## Local retention query-plan seed

The explicit Prisma seed creates 100,000 synthetic `usage_records` and 100,000
matching `dispatch_attempts`, with timestamps spread across 210 days so a
30-day retention cutoff has expired rows to examine. It runs `ANALYZE` on both
tables afterwards. The command requires `AIHUB_BENCHMARK_SEED=1` and only accepts
the local `aihub` or `aihub_benchmark` database. It replaces only rows whose
request IDs start with `aihub-benchmark-retention-`. Run `pnpm migrate` first
so the local schema matches the checked-in migration history.

```bash
AIHUB_BENCHMARK_SEED=1 \
DATABASE_URL=postgres://aihub:change-me@localhost:5432/aihub \
pnpm db:seed
```

The Prisma CLI runs this seed only when `pnpm db:seed` is invoked explicitly;
it is not part of `pnpm migrate`, `prisma migrate dev`, or application startup.

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
   pnpm check:migrations      # Squawk migration policy
   pnpm check:prisma-drift    # the schema and the history still agree
   ```

`pnpm check:migrations` remains the contributor-facing command and is part of
`pnpm verify`. It invokes the pinned Squawk linter; the custom three-pattern
checker has been removed. A migration that drops or renames a column, or adds a
required column without a default, must still fail. Use a rule-specific
`squawk-ignore` only for a reviewed exception, with its reason and approving
issue on the same SQL comment.

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
schema, so #693 keeps this contract in `pnpm verify` and CI, with Squawk as the
guard:

```text
PERMITTED:  CREATE TABLE, ADD nullable column, ADD ... NOT NULL DEFAULT
FORBIDDEN:  DROP COLUMN, RENAME COLUMN, ADD ... NOT NULL without DEFAULT
```

`ADD COLUMN ... NOT NULL DEFAULT` is permitted because PostgreSQL backfills the
existing rows in the same statement.

The Squawk configuration targets PostgreSQL 16 and assumes each migration runs
inside a transaction, matching `scripts/cli/migrate.mjs`. Its `excluded_paths`
must list the 40 already-applied migration files explicitly; do not use a broad
glob that could hide future files. New migration files remain checked.

The migration runner sets PostgreSQL `lock_timeout` to 30 seconds and
`statement_timeout` to 300 seconds on its connection. #693 therefore excludes
Squawk's `require-lock-timeout` and `require-statement-timeout` rules with that
reason; the runner remains the single owner of these settings. Keep
`prefer-robust-stmts`, `prefer-bigint-over-int`, and
`require-concurrent-index-creation` enabled. If an INTEGER is intentional, or a
regular index is safe because its table is created in the same migration, use a
per-statement ignore with a reason and approving issue. Existing-table indexes
remain subject to the concurrent-index rule. The current runner wraps every
file in a transaction, so support for `CREATE INDEX CONCURRENTLY` in a
non-transactional migration belongs to #283.

When #283 adds a non-transactional migration, mark only that file with
`squawk-disable-assume-in-transaction`; this lets Squawk check retry-safe
statements there while retaining the transaction assumption for other files.

For example, an intentional 32-bit value can use this narrow exception:

```sql
CREATE TABLE bounded_retry_state (retry_count INTEGER NOT NULL CHECK (retry_count BETWEEN 0 AND 1000)); -- squawk-ignore prefer-bigint-over-int -- retry_count is bounded; approved: #693
```

When adding a value to an existing value-list `CHECK`, drop the old constraint
and add the expanded constraint marked `NOT VALID` in one migration file. Squawk
requires a narrow ignore for the drop because this is the reviewed atomic
replacement:

```sql
-- squawk-ignore ban-drop-constraint -- reason: atomically replace the value-list CHECK; approved: #693
ALTER TABLE organizations DROP CONSTRAINT organizations_status_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_status_check CHECK (status IN ('active', 'suspended', 'pending')) NOT VALID;
```

Validate it in the next migration file, after the first file has committed.
`NOT VALID`
avoids scanning every existing row while installing the new rule, and the new
constraint still governs rows written after it commits. Validation then checks
the old rows under the lighter lock used by `VALIDATE CONSTRAINT`. If the change
removes an allowed value, first remove or update rows that still use it before
validating.

For a genuine contract migration, first ship the additive replacement and
backfill, switch readers, then deploy the destructive cleanup separately days
later. Put a rule-specific ignore on the affected statement with its reason and
approving issue, using the rule identifier Squawk reports:

```sql
ALTER TABLE example DROP COLUMN old_field; -- squawk-ignore <rule> -- reason: old field fully replaced; approved: #123
```

The rule identifier must match the finding; do not suppress a whole file or
rule globally to permit one exception. Review schema changes that Squawk does
not cover, including views, triggers, extensions, and `SET NOT NULL`, separately.

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
