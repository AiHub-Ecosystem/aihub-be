import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';

import pg from 'pg';

const { Pool } = pg;

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = await readFile(
  'database/migrations/0001_control_plane.sql',
  'utf8',
);
const pool = new Pool({ connectionString: databaseUrl });

try {
  await pool.query(sql);
  console.log('Database migration applied');
} catch {
  console.error('Database migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
