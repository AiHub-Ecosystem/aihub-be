#!/usr/bin/env node
/**
 * Writes the SQL for the next control-plane migration (ADR-0088, #40).
 *
 * `prisma/schema.prisma` is the shape; `database/migrations/` is what builds a
 * database. This prints the statements that carry one to the other, numbered
 * for the existing runner (`pnpm migrate`) that keeps applying them.
 *
 * The comparison needs a database already at the current migration state,
 * because that is what "before" means. Run `pnpm migrate` first.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/generate/generate-migration.mjs add_slug
 *
 * The generated file is an ordinary SQL file: review it, hand-edit it to add
 * the objects this schema language cannot declare, and commit it. Generation
 * removes the second hand-maintained copy of the schema, not the review.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'database/migrations';
const SCHEMA = 'prisma/schema.prisma';

function nextMigrationNumber() {
  const highest = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => Number.parseInt(name.slice(0, 4), 10))
    .filter((value) => Number.isInteger(value))
    .reduce((largest, value) => Math.max(largest, value), 0);

  return String(highest + 1).padStart(4, '0');
}

const slug = process.argv[2];

if (!slug || !/^[a-z0-9_]+$/.test(slug)) {
  console.error(
    'usage: DATABASE_URL=postgres://... node scripts/generate/generate-migration.mjs <name_in_snake_case>',
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL must name a database already built from the current migrations; run `pnpm migrate` first.',
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    // Invoked through its entry point rather than `npx`: a shell would split a
    // repository path at a space in a user profile name.
    require.resolve('prisma/build/index.js'),
    'migrate',
    'diff',
    '--from-config-datasource',
    '--to-schema',
    SCHEMA,
    '--script',
  ],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      AIHUB_DRIFT_CHECK_DATABASE_URL: process.env.DATABASE_URL,
    },
  },
);

if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const sql = result.stdout.trim();

if (sql === '' || sql.includes('-- This is an empty migration.')) {
  console.error(
    'schema.prisma and the database already agree. Change the schema first, or check that DATABASE_URL points at a database built from the current migrations.',
  );
  process.exit(1);
}

const target = join(MIGRATIONS_DIR, `${nextMigrationNumber()}_${slug}.sql`);

if (existsSync(target)) {
  console.error(`${target} already exists.`);
  process.exit(1);
}

writeFileSync(target, `${sql}\n`);
console.log(
  `Wrote ${target}. Review it, hand-edit it, then run \`pnpm migrate\`.`,
);
