import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process, { loadEnvFile } from 'node:process';

import { Pool } from 'pg';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const runtimeConnectionModule = new URL(
  '../../dist/modules/secrets/infrastructure/runtime-connection.environment.js',
  import.meta.url,
);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {unknown} value @returns {value is (options: {env: NodeJS.ProcessEnv}) => void} */
function isRuntimeConnectionLoader(value) {
  return typeof value === 'function';
}

if (existsSync(runtimeConnectionModule)) {
  const runtimeConnection = /** @type {unknown} */ (
    await import(runtimeConnectionModule)
  );
  const defaultExport = isRecord(runtimeConnection)
    ? runtimeConnection.default
    : undefined;
  const directLoader = isRecord(runtimeConnection)
    ? runtimeConnection.loadRuntimeConnectionEnvironment
    : undefined;
  const defaultLoader = isRecord(defaultExport)
    ? defaultExport.loadRuntimeConnectionEnvironment
    : undefined;
  const loadRuntimeConnectionEnvironment = isRuntimeConnectionLoader(
    directLoader,
  )
    ? directLoader
    : isRuntimeConnectionLoader(defaultLoader)
      ? defaultLoader
      : undefined;
  if (loadRuntimeConnectionEnvironment === undefined) {
    throw new Error('runtime connection loader is unavailable');
  }
  loadRuntimeConnectionEnvironment({ env: process.env });
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const MIGRATIONS_DIR = 'prisma/migrations';

/** @param {Pool} pool @returns {Promise<Array<{filename: string, path: string}>>} */
async function pendingMigrations(pool) {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      filename: `${entry.name}.sql`,
      path: join(MIGRATIONS_DIR, entry.name, 'migration.sql'),
    }))
    .sort((left, right) => left.filename.localeCompare(right.filename));

  const applied = /** @type {import('pg').QueryResult<{filename: string}>} */ (
    await pool.query('SELECT filename FROM schema_migrations')
  );
  const appliedNames = new Set(applied.rows.map((row) => row.filename));

  return migrations.filter(({ filename }) => !appliedNames.has(filename));
}

const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 300_000,
  lock_timeout: 30_000,
  idle_in_transaction_session_timeout: 60_000,
});

try {
  // Bootstraps itself rather than living as migration 0001, so a fresh
  // database and one that predates this tracking table both converge here.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const pending = await pendingMigrations(pool);

  if (pending.length === 0) {
    console.log('No pending migrations');
  }

  for (const migration of pending) {
    const sql = await readFile(migration.path, 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [migration.filename],
      );
      await client.query('COMMIT');
      console.log(`Applied ${migration.filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration failed: ${migration.filename}`, {
        cause: error,
      });
    } finally {
      client.release();
    }
  }

  console.log('Database migration complete');
} catch (error) {
  // A migration wraps the driver error in `cause`; without it the log names
  // the file that failed and nothing about why.
  console.error(
    error instanceof Error
      ? `${error.message}${
          error.cause instanceof Error ? `: ${error.cause.message}` : ''
        }`
      : 'Migration failed',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
