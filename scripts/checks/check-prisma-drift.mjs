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
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { Client } from 'pg';

const require = createRequire(import.meta.url);
const { driftStatements } = require('./prisma-drift.cjs');

const MIGRATIONS_DIR = 'database/migrations';
const SCRATCH_DATABASE_NAME = 'aihub_prisma_drift';

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

function scratchDatabaseUrl(adminUrl) {
  const url = new URL(adminUrl);
  url.pathname = `/${SCRATCH_DATABASE_NAME}`;
  return url.toString();
}

/**
 * Host and database only. The admin URL carries a password, so it never
 * reaches an error message or a log line.
 */
function adminTarget(adminUrl) {
  const admin = new URL(adminUrl);
  return `${admin.host}${admin.pathname}`;
}

async function applyMigrations(url) {
  const target = new Client({ connectionString: url });
  await target.connect();
  try {
    const entries = (await readdir(MIGRATIONS_DIR)).filter((name) =>
      name.endsWith('.sql'),
    );
    entries.sort();

    for (const filename of entries) {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      try {
        await target.query(sql);
      } catch (error) {
        throw new Error(`Migration failed: ${filename}`, { cause: error });
      }
    }
  } finally {
    await target.end();
  }
}

async function main() {
  const adminUrl = adminDatabaseUrl();
  const admin = new Client({ connectionString: adminUrl });

  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `The drift check needs PostgreSQL at ${adminTarget(adminUrl)}.`,
      { cause: error },
    );
  }

  try {
    await admin.query(
      `DROP DATABASE IF EXISTS ${SCRATCH_DATABASE_NAME} WITH (FORCE)`,
    );
    await admin.query(`CREATE DATABASE ${SCRATCH_DATABASE_NAME}`);
  } finally {
    await admin.end();
  }

  const scratchUrl = scratchDatabaseUrl(adminUrl);
  await applyMigrations(scratchUrl);

  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const diff = spawnSync(
    command,
    [
      'prisma',
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--script',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, AIHUB_DRIFT_CHECK_DATABASE_URL: scratchUrl },
      shell: process.platform === 'win32',
    },
  );

  if (diff.status !== 0) {
    console.error(diff.stderr || diff.stdout);
    throw new Error('prisma migrate diff failed');
  }

  const drifted = driftStatements(diff.stdout);

  const cleanup = new Client({ connectionString: adminUrl });
  await cleanup.connect();
  try {
    await cleanup.query(
      `DROP DATABASE IF EXISTS ${SCRATCH_DATABASE_NAME} WITH (FORCE)`,
    );
  } finally {
    await cleanup.end();
  }

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
