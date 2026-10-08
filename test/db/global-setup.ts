import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';

import {
  SANDBOX_TEST_DATABASE_NAME,
  TEST_DATABASE_NAME,
  adminDatabaseUrl,
  adminTarget,
  sandboxTestDatabaseUrl,
  testDatabaseUrl,
} from './database';

const MIGRATIONS_DIR = join(__dirname, '../../database/migrations');

/**
 * Rebuilds the lane's database from the repository's own migration files.
 *
 * They are applied here rather than by shelling out to `scripts/cli/migrate.mjs`:
 * that script loads the runtime connection environment when `dist/` is built,
 * which overwrites `DATABASE_URL` and would point this lane at whatever
 * database the developer's runtime secrets name. Reading the same files keeps
 * the schema honest while making it impossible for the lane to reach past the
 * database it created.
 */
export default async function globalSetup(): Promise<void> {
  const admin = new Client({ connectionString: adminDatabaseUrl() });

  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `The database lane needs PostgreSQL at ${adminTarget()}. Start it with "docker compose up -d postgres".`,
      { cause: error },
    );
  }

  try {
    await admin.query(
      `DROP DATABASE IF EXISTS ${TEST_DATABASE_NAME} WITH (FORCE)`,
    );
    await admin.query(`CREATE DATABASE ${TEST_DATABASE_NAME}`);
    await admin.query(
      `DROP DATABASE IF EXISTS ${SANDBOX_TEST_DATABASE_NAME} WITH (FORCE)`,
    );
    await admin.query(`CREATE DATABASE ${SANDBOX_TEST_DATABASE_NAME}`);
  } finally {
    await admin.end();
  }

  const entries = await readdir(MIGRATIONS_DIR);
  const migrations = entries.filter((name) => name.endsWith('.sql')).sort();

  for (const databaseUrl of [testDatabaseUrl(), sandboxTestDatabaseUrl()]) {
    const target = new Client({ connectionString: databaseUrl });
    await target.connect();
    try {
      for (const filename of migrations) {
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
}
