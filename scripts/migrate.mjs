import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';

import pg from 'pg';

const { Pool } = pg;

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const runtimeConnectionModule = new URL(
  '../dist/modules/secrets/infrastructure/runtime-connection.environment.js',
  import.meta.url,
);
if (existsSync(runtimeConnectionModule)) {
  const runtimeConnection = await import(runtimeConnectionModule);
  const loadRuntimeConnectionEnvironment =
    runtimeConnection.loadRuntimeConnectionEnvironment ??
    runtimeConnection.default?.loadRuntimeConnectionEnvironment;
  if (typeof loadRuntimeConnectionEnvironment !== 'function') {
    throw new Error('runtime connection loader is unavailable');
  }
  loadRuntimeConnectionEnvironment();
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const MIGRATIONS_DIR = 'database/migrations';

async function pendingMigrations(pool) {
  const entries = await readdir(MIGRATIONS_DIR);
  const filenames = entries.filter((name) => name.endsWith('.sql')).sort();

  const applied = await pool.query('SELECT filename FROM schema_migrations');
  const appliedNames = new Set(applied.rows.map((row) => row.filename));

  return filenames.filter((filename) => !appliedNames.has(filename));
}

const pool = new Pool({ connectionString: databaseUrl });

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

  for (const filename of pending) {
    const sql = await readFile(`${MIGRATIONS_DIR}/${filename}`, 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [filename],
      );
      await client.query('COMMIT');
      console.log(`Applied ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration failed: ${filename}`, { cause: error });
    } finally {
      client.release();
    }
  }

  console.log('Database migration complete');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
