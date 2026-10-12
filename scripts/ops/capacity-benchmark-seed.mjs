import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import argon2 from 'argon2';
import { Pool } from 'pg';
import { ulid } from 'ulid';

import apiKeyModule from '../../dist/modules/identity/domain/api-key.js';

const { generateApiKey } = apiKeyModule;

const databaseUrl = process.env.DATABASE_URL;
const outputDir = process.env.BENCHMARK_DATA_DIR ?? '/data';
const userCount = positiveInteger(process.env.BENCHMARK_USER_COUNT, 512);
const organizationCount = positiveInteger(
  process.env.BENCHMARK_ORGANIZATION_COUNT,
  4,
);
const usageRowsPerOrganization = positiveInteger(
  process.env.BENCHMARK_USAGE_ROWS_PER_ORGANIZATION,
  5000,
);
const password = 'BenchmarkOnly!2026';

if (databaseUrl === undefined || organizationCount < 2 || userCount < 1) {
  throw new Error('invalid benchmark seed configuration');
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value))
    throw new Error('benchmark count must be an integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('benchmark count must be a positive safe integer');
  }
  return parsed;
}

function token() {
  return randomBytes(32).toString('base64url');
}

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const now = new Date();
const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
const passwordHash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
});
const organizations = [];
const users = [];
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

try {
  await pool.query('BEGIN');

  for (let index = 0; index < organizationCount; index += 1) {
    const organizationId = `org_${ulid()}`;
    const apiKey = generateApiKey(`ak_${ulid()}`);
    await pool.query(
      `INSERT INTO organizations (
         id, name, status, entitlements, rate_limit_rpm, max_concurrent,
         monthly_request_quota, hard_stop_on_quota, created_at, updated_at
       ) VALUES ($1, $2, 'active', ARRAY['writing', 'speaking'],
         10000, 20, 1000000, false, $3, $3)`,
      [organizationId, `Capacity benchmark ${index + 1}`, now],
    );
    await pool.query(
      `INSERT INTO api_keys (
         id, organization_id, key_hash, key_prefix, name, scopes,
         allowed_environments, status, created_at
       ) VALUES ($1, $2, decode($3, 'hex'), $4, 'capacity benchmark',
         ARRAY['writing.grade', 'speaking.grade'], ARRAY['production'],
         'active', $5)`,
      [apiKey.id, organizationId, apiKey.hash, apiKey.prefix, now],
    );
    organizations.push({ id: organizationId, apiKey: apiKey.raw });
  }

  for (let index = 0; index < userCount; index += 1) {
    const userId = `usr_${ulid()}`;
    const email = `capacity-${String(index + 1).padStart(4, '0')}@example.invalid`;
    const refreshToken = token();
    const webSessionToken = token();
    users.push({
      email,
      userId,
      password,
      refreshToken,
      webSessionToken,
    });
    await pool.query(
      `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
       VALUES ($1, $2, 'active', $3, $3)`,
      [userId, `capacity-${String(index + 1).padStart(4, '0')}`, now],
    );
    await pool.query(
      `INSERT INTO auth_identities (
         id, user_account_id, provider, canonical_email, password_hash,
         created_at, updated_at
       ) VALUES ($1, $2, 'password', $3, $4, $5, $5)`,
      [`auth_${ulid()}`, userId, email, passwordHash, now],
    );
    await pool.query(
      `INSERT INTO refresh_tokens (
         id, family_id, user_account_id, token_hash, issued_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        `rft_${ulid()}`,
        `rfs_${ulid()}`,
        userId,
        hash(refreshToken),
        now,
        expiry,
      ],
    );
    await pool.query(
      `INSERT INTO web_sessions (
         id, user_account_id, token_hash, created_at, expires_at, last_renewed_at
       ) VALUES ($1, $2, $3, $4, $5, $4)`,
      [`wbs_${ulid()}`, userId, hash(webSessionToken), now, expiry],
    );
  }

  for (let index = 0; index < organizationCount; index += 1) {
    const organization = organizations[index];
    if (organization === undefined) throw new Error('missing benchmark org');
    await pool.query(
      `INSERT INTO usage_records (
         request_id, organization_id, api_key_id, actor_id, service, operation,
         environment, outcome, http_status, billable_requests, input_tokens,
         output_tokens, total_tokens, metering_status, total_ms, downstream_ms,
         ai_processing_ms, created_at
       )
       SELECT
         'bench_' || $1 || '_' || sequence,
         $2,
         (SELECT id FROM api_keys WHERE organization_id = $2 LIMIT 1),
         'capacity-benchmark-user',
         CASE WHEN sequence % 4 < 2 THEN 'ai-writing' ELSE 'ai-speaking' END,
         CASE sequence % 4
           WHEN 0 THEN 'writing.task1.grade'
           WHEN 1 THEN 'writing.task2.grade'
           WHEN 2 THEN 'speaking.grading'
           ELSE 'speaking.grading-json'
         END,
         'production', 'success', 200, 1, 100, 100, 200,
         'complete', 2200, 2000, 1800,
         now() - (sequence * interval '5 milliseconds')
       FROM generate_series(1, $3::integer) AS sequence`,
      [index + 1, organization.id, usageRowsPerOrganization],
    );
  }

  await pool.query('COMMIT');
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, 'credentials.json'),
    JSON.stringify({ organizations, users }),
    { mode: 0o644 },
  );
  process.stdout.write(
    `Seeded ${organizations.length} synthetic organizations, ${users.length} active MFA-disabled users, and ${organizations.length * usageRowsPerOrganization} usage rows.\n`,
  );
} catch (error) {
  await pool.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}
