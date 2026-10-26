import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { Pool } from 'pg';
import { ulid } from 'ulid';

const databaseUrl = process.env.DATABASE_URL;
const outputDir = process.env.BENCHMARK_DATA_DIR ?? '/data';

if (databaseUrl === undefined) {
  throw new Error('invalid benchmark database configuration');
}

/** @typedef {{userId: string, refreshToken: string}} BenchmarkUser */

const credentials = /** @type {unknown} */ (
  JSON.parse(await readFile(path.join(outputDir, 'credentials.json'), 'utf8'))
);
const users = parseBenchmarkUsers(credentials);

const now = new Date();
const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
const tokenRows = users.map((user) => ({
  id: `rft_${ulid()}`,
  family_id: `rfs_${ulid()}`,
  user_account_id: user.userId,
  token_hash: createHash('sha256')
    .update(user.refreshToken, 'utf8')
    .digest('hex'),
}));
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

/** @param {unknown} value @returns {BenchmarkUser[]} */
function parseBenchmarkUsers(value) {
  if (!isRecord(value)) {
    throw new Error('benchmark refresh-token seed is incomplete');
  }
  const userValues = value.users;
  if (!Array.isArray(userValues) || userValues.length === 0) {
    throw new Error('benchmark refresh-token seed is incomplete');
  }
  /** @type {unknown[]} */
  const users = userValues;
  const parsed = users.map((user) => {
    if (
      !isRecord(user) ||
      typeof user.userId !== 'string' ||
      !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(user.userId) ||
      typeof user.refreshToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(user.refreshToken)
    ) {
      throw new Error('benchmark refresh-token seed is incomplete');
    }
    return { userId: user.userId, refreshToken: user.refreshToken };
  });
  if (new Set(parsed.map(({ userId }) => userId)).size !== parsed.length) {
    throw new Error('benchmark refresh-token seed is incomplete');
  }
  return parsed;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM refresh_tokens WHERE user_account_id = ANY($1::text[])',
      [users.map((user) => user.userId)],
    );
    await client.query(
      `INSERT INTO refresh_tokens (
         id, family_id, user_account_id, token_hash, issued_at, expires_at
       )
       SELECT id, family_id, user_account_id, token_hash, $2, $3
       FROM jsonb_to_recordset($1::jsonb) AS seed(
         id text, family_id text, user_account_id text, token_hash text
       )`,
      [JSON.stringify(tokenRows), now, expiry],
    );
    await client.query('COMMIT');
    process.stdout.write(
      `Reset refresh-token state for ${users.length} benchmark users.\n`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
