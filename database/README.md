# Database migrations — expand-only contract

`database/migrations/*.sql` is applied in filename order by `scripts/migrate.mjs`. Two application versions run against one schema during rolling deploys, so the check `scripts/check-migrations.mjs` enforces the expand-only contract in `pnpm verify` (and CI).

## Permitted / forbidden

```
PERMITTED:  CREATE TABLE, ADD nullable column, CREATE INDEX CONCURRENTLY
FORBIDDEN:  DROP COLUMN, RENAME COLUMN, ADD ... NOT NULL without DEFAULT
```

`ADD COLUMN ... NOT NULL DEFAULT` is permitted — the default backfills existing rows in the same statement.

## How the check works

- Reads `database/migrations/*.sql` sorted, splits each file into `;`-terminated statements after stripping `--` line comments and `/* */` blocks.
- Case-insensitive: `DROP COLUMN`, `RENAME COLUMN`, `ADD COLUMN ... NOT NULL` without `DEFAULT` in the same statement.
- Failure message names `file:line — statement — kind — expand/contract alternative`, not just “forbidden pattern”.

Example:

```
Migration check failed: 0018_drop_email.sql:2 — ALTER TABLE foo DROP COLUMN email — drop-column — use expand/contract: ADD new column nullable, backfill, switch reads, drop in contract deployment days later (spec)
```

Run: `pnpm check:migrations` or `pnpm verify`.

## Escape hatch for genuine contract migrations

When a destructive change is truly needed, land it as a **separate cleanup deployment days later** (spec). The check needs an explicit marker in the migration file — no silent grandfathering.

Add as the first line(s) of the migration:

```sql
-- expand-contract: allow-drop-column — reason: email replaced by username, backfill done — approved: #123
-- expand-contract: allow-rename-column — reason: ... — approved: #123
-- expand-contract: allow-add-not-null — reason: ... — approved: #123
```

Marker must match the violated kind (`drop-column`, `rename-column`, `add-not-null`), otherwise the check still fails. One marker per kind, may have multiple markers if a file needs several.

No blanket file-level suppression — marker is per-kind with written reason and approver.

## What the check does NOT catch

Green does **not** mean full expand-only proof. The check is narrow and honest rather than a SQL parser:

- `;` inside dollar-quoted `$$`, single-quoted strings with escaped `''`, or `CREATE FUNCTION` bodies
- `ALTER TYPE`, `DROP TABLE`, `DROP CONSTRAINT`, `ALTER COLUMN TYPE`
- `CREATE INDEX` without `CONCURRENTLY`
- Views, materialized views, triggers, extensions
- `NOT NULL` added via separate `ALTER COLUMN ... SET NOT NULL` (not `ADD COLUMN`)

False sense of coverage is worse than a small checked set. Where a change is outside the 3 families, review it as if the check did not exist.

## Existing migrations

17/17 pass at time of wiring (#111): `0001`–`0017` contain no forbidden patterns. `0013` has `ADD COLUMN ... NOT NULL DEFAULT ''` and correctly passes. Any future violation in history will be reported rather than silently grandfathered — no ignore list.
