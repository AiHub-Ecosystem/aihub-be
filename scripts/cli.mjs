import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import Redis from 'ioredis';
import pg from 'pg';
import { ulid } from 'ulid';

const { Pool } = pg;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const API_KEY_PREFIX = 'aihub_sk_';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

function usageError() {
  throw new Error('Invalid CLI arguments');
}

function parseOptions(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (typeof name !== 'string' || !name.startsWith('--')) {
      usageError();
    }
    const value = values[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) {
      usageError();
    }
    options.set(name.slice(2), value);
    index += 1;
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (value === undefined || value.trim().length === 0) {
    usageError();
  }
  return value.trim();
}

function listOption(options, name, fallback) {
  const value = options.get(name) ?? fallback;
  const values = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (values.length === 0) {
    usageError();
  }
  return values;
}

function positiveIntegerOption(options, name, fallback) {
  const raw = options.get(name) ?? fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    usageError();
  }
  return value;
}

function createApiKey() {
  let value = BigInt(`0x${randomBytes(32).toString('hex')}`);
  let secret = '';
  while (value > 0n) {
    const index = Number(value % 62n);
    const character = BASE62[index];
    if (character === undefined) {
      usageError();
    }
    secret = character + secret;
    value /= 62n;
  }
  return `${API_KEY_PREFIX}${secret.padStart(43, '0')}`;
}

function databasePool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  return new Pool({ connectionString: databaseUrl });
}

async function createOrganization(options) {
  const pool = databasePool();
  try {
    const result = await pool.query(
      `INSERT INTO organizations (id, name, entitlements, rate_limit_rpm, max_concurrent)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        `org_${ulid()}`,
        requiredOption(options, 'name'),
        listOption(options, 'entitlements', 'writing'),
        positiveIntegerOption(options, 'rate-limit-rpm', '600'),
        positiveIntegerOption(options, 'max-concurrent', '20'),
      ],
    );
    console.log(result.rows[0].id);
  } finally {
    await pool.end();
  }
}

async function createKey(options) {
  const pool = databasePool();
  try {
    const organizationId = requiredOption(options, 'org');
    const organization = await pool.query(
      "SELECT 1 FROM organizations WHERE id = $1 AND status = 'active'",
      [organizationId],
    );
    if (organization.rowCount !== 1) {
      usageError();
    }

    const rawKey = createApiKey();
    const keyHash = createHash('sha256').update(rawKey, 'utf8').digest();
    await pool.query(
      `INSERT INTO api_keys
         (id, organization_id, key_hash, key_prefix, name, scopes, allowed_environments)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        `ak_${ulid()}`,
        organizationId,
        keyHash,
        rawKey.slice(0, 15),
        requiredOption(options, 'name'),
        listOption(options, 'scopes', 'writing.question.generate'),
        listOption(options, 'envs', 'production'),
      ],
    );

    // The raw credential is intentionally printed once and never persisted.
    console.log(rawKey);
  } finally {
    await pool.end();
  }
}

async function revokeKey(options) {
  const pool = databasePool();
  let hashHex;
  try {
    const keyId = requiredOption(options, 'key');
    const result = await pool.query(
      "SELECT encode(key_hash, 'hex') AS hash_hex FROM api_keys WHERE id = $1",
      [keyId],
    );
    const row = result.rows[0];
    if (row === undefined || typeof row.hash_hex !== 'string') {
      usageError();
    }
    hashHex = row.hash_hex;
    await pool.query(
      `UPDATE api_keys
       SET status = 'revoked', revoked_at = now()
       WHERE id = $1`,
      [keyId],
    );
  } finally {
    await pool.end();
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl !== undefined && redisUrl.trim().length > 0) {
    const redis = new Redis(redisUrl, {
      commandTimeout: 100,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redis.on('error', () => undefined);
    try {
      await redis.del(
        `aihub:v1:key:${hashHex}`,
        `aihub:v1:key:miss:${hashHex}`,
      );
    } finally {
      await redis.quit();
    }
  }
}

async function main() {
  const [command, ...values] = process.argv.slice(2);
  const options = parseOptions(values);

  if (command === 'org:create') {
    await createOrganization(options);
    return;
  }
  if (command === 'key:create') {
    await createKey(options);
    return;
  }
  if (command === 'key:revoke') {
    await revokeKey(options);
    return;
  }

  usageError();
}

main().catch(() => {
  console.error('Command failed');
  process.exitCode = 1;
});
