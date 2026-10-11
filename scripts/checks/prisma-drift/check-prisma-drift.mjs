#!/usr/bin/env node
/**
 * Fails when `prisma/schema.prisma` and `database/migrations/` disagree
 * (ADR-0088, #40).
 *
 * Migrations still build every database, so this check builds one from them in
 * a scratch database and asks Prisma what it would change to reach the schema.
 * An empty answer means the two are the same thing; anything else means a
 * column, index, or constraint exists in one and not the other, and the next
 * generated migration would be guessing which.
 *
 * Runs beside the database lane because it needs PostgreSQL. It creates and
 * drops its own database and never touches a developer's working one.
 *
 * Usage: `pnpm check:prisma-drift`
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { driftAgainstMigrations } = require('./prisma-drift.cjs');

/**
 * The lane's own default, so CI exercises the same path a developer does.
 * `DB_LANE_ADMIN_URL` points the check at another PostgreSQL, exactly as it
 * points the database lane there.
 */
const DEFAULT_ADMIN_URL = 'postgres://aihub:change-me@localhost:5432/aihub';

function adminDatabaseUrl() {
  const configured = process.env.DB_LANE_ADMIN_URL?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : DEFAULT_ADMIN_URL;
}

async function main() {
  const drifted = await driftAgainstMigrations({
    adminUrl: adminDatabaseUrl(),
    migrationsDir: 'database/migrations',
    schemaPath: 'prisma/schema.prisma',
  });

  if (drifted.length > 0) {
    console.error(
      'schema.prisma and database/migrations/ disagree. The statements below ' +
        'are what Prisma would apply to reach the schema, so one of the two ' +
        'needs to change:',
    );
    for (const statement of drifted) {
      console.error(`  ${statement}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('schema.prisma agrees with database/migrations/.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
