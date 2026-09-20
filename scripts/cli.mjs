import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';

import { ulid } from 'ulid';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const API_KEY_PREFIX = 'aihub_sk_';
const IDENTITY_CONFIG_ALGORITHMS = new Set(['RS256', 'ES256']);
const DEFAULT_ASSERTION_TTL_SECONDS = 300;
const MAX_ASSERTION_TTL_SECONDS = 3600;
const PRIVATE_JWK_MEMBERS = new Set([
  'd',
  'p',
  'q',
  'dp',
  'dq',
  'qi',
  'oth',
  'k',
]);

import {
  CliUsageError,
  booleanOption,
  environmentListOption,
  quotaOption,
  usageError,
} from './cli-options.cjs';
import {
  parseTargetMonth,
  runQuotaReconciliation,
} from './quota-reconcile.cjs';
import { runUsagePrune } from './usage-prune.cjs';
import { runUsageReport } from './usage-report.cjs';

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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateIdentityIssuer(options) {
  const issuer = requiredOption(options, 'issuer');
  if (issuer.length > 2048) {
    usageError();
  }
  return issuer;
}

function validateIdentityAlgorithms(options) {
  const raw = options.get('allowed-algorithms');
  if (raw === undefined) {
    return undefined;
  }

  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((value) => !IDENTITY_CONFIG_ALGORITHMS.has(value))
  ) {
    usageError();
  }
  return values;
}

function validateIdentityTtl(options) {
  const raw = options.get('max-assertion-ttl-seconds');
  if (raw === undefined) {
    return undefined;
  }

  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_ASSERTION_TTL_SECONDS
  ) {
    usageError();
  }
  return value;
}

function validateJwksUrl(options) {
  if (!options.has('jwks-url')) {
    return null;
  }

  const value = requiredOption(options, 'jwks-url');
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      usageError();
    }
  } catch {
    usageError();
  }
  return value;
}

function validatePublicJwks(value) {
  if (
    !isRecord(value) ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0
  ) {
    usageError();
  }

  for (const key of value.keys) {
    if (!isRecord(key)) {
      usageError();
    }
    if (
      Object.keys(key).some((member) => PRIVATE_JWK_MEMBERS.has(member)) ||
      (key.alg !== undefined && !IDENTITY_CONFIG_ALGORITHMS.has(key.alg))
    ) {
      usageError();
    }

    if (
      (key.alg === 'RS256' && key.kty !== 'RSA') ||
      (key.alg === 'ES256' && key.kty !== 'EC')
    ) {
      usageError();
    }

    if (key.kty === 'RSA') {
      if (
        typeof key.n !== 'string' ||
        key.n.length === 0 ||
        typeof key.e !== 'string' ||
        key.e.length === 0
      ) {
        usageError();
      }
      continue;
    }

    if (
      key.kty !== 'EC' ||
      key.crv !== 'P-256' ||
      typeof key.x !== 'string' ||
      key.x.length === 0 ||
      typeof key.y !== 'string' ||
      key.y.length === 0
    ) {
      usageError();
    }
  }

  return value;
}

async function readPublicKeysFile(options) {
  if (!options.has('public-keys-file')) {
    return null;
  }

  const file = requiredOption(options, 'public-keys-file');
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    usageError();
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch {
    usageError();
  }
  return validatePublicJwks(value);
}

async function parseIdentityOptions(options) {
  const organizationId = requiredOption(options, 'org');
  const status = options.get('status');
  if (status !== undefined && status !== 'active' && status !== 'disabled') {
    usageError();
  }

  const hasIdentityFields = [
    'issuer',
    'jwks-url',
    'public-keys-file',
    'allowed-algorithms',
    'max-assertion-ttl-seconds',
  ].some((name) => options.has(name));

  if (status === 'disabled' && !hasIdentityFields) {
    return { organizationId, disableOnly: true };
  }

  const hasJwksUrl = options.has('jwks-url');
  const hasPublicKeysFile = options.has('public-keys-file');
  if (!hasJwksUrl && !hasPublicKeysFile) {
    usageError();
  }

  return {
    organizationId,
    disableOnly: false,
    issuer: validateIdentityIssuer(options),
    jwksUrl: validateJwksUrl(options),
    publicKeysJwks: await readPublicKeysFile(options),
    allowedAlgorithms: validateIdentityAlgorithms(options),
    maxAssertionTtlSeconds: validateIdentityTtl(options),
    status,
  };
}

function existingIdentityAlgorithms(row) {
  if (
    !Array.isArray(row.allowed_algorithms) ||
    row.allowed_algorithms.length === 0 ||
    new Set(row.allowed_algorithms).size !== row.allowed_algorithms.length ||
    row.allowed_algorithms.some(
      (value) => !IDENTITY_CONFIG_ALGORITHMS.has(value),
    )
  ) {
    usageError();
  }
  return row.allowed_algorithms;
}

function existingIdentityTtl(row) {
  if (
    !Number.isInteger(row.max_assertion_ttl_seconds) ||
    row.max_assertion_ttl_seconds <= 0 ||
    row.max_assertion_ttl_seconds > MAX_ASSERTION_TTL_SECONDS
  ) {
    usageError();
  }
  return row.max_assertion_ttl_seconds;
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

async function databasePool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: databaseUrl });
}

async function createOrganization(options) {
  const pool = await databasePool();
  try {
    const result = await pool.query(
      `INSERT INTO organizations
         (id, name, entitlements, rate_limit_rpm, max_concurrent,
          monthly_request_quota, hard_stop_on_quota)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        `org_${ulid()}`,
        requiredOption(options, 'name'),
        listOption(options, 'entitlements', 'writing'),
        positiveIntegerOption(options, 'rate-limit-rpm', '600'),
        positiveIntegerOption(options, 'max-concurrent', '20'),
        // Quota and hard stop live on the organization, not the key: they are
        // one budget shared by every key it issues, which is what makes
        // per-person keys safe to hand out.
        quotaOption(options, 'monthly-quota'),
        booleanOption(options, 'hard-stop'),
      ],
    );
    console.log(result.rows[0].id);
  } finally {
    await pool.end();
  }
}

async function createKey(options) {
  const pool = await databasePool();
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
        listOption(options, 'scopes', 'writing.grade'),
        environmentListOption(options, 'envs', 'production'),
      ],
    );

    // The raw credential is intentionally printed once and never persisted.
    console.log(rawKey);
  } finally {
    await pool.end();
  }
}

async function revokeKey(options) {
  const keyId = requiredOption(options, 'key');
  const pool = await databasePool();
  let hashHex;
  try {
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

  // The row is committed by this point. What follows only closes the window
  // where the identity cache would still admit the key, so its failure must
  // read differently from the revocation failing — an operator revoking a
  // leaked credential needs to know which of the two happened.
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl === undefined || redisUrl.trim().length === 0) {
    console.error(
      `Revoked ${keyId}. REDIS_URL is unset, so the identity cache was not purged; the key may still be accepted for up to 60 seconds.`,
    );
    return;
  }

  const { default: Redis } = await import('ioredis');
  // `lazyConnect` and an explicit `connect()` are what make this work at all.
  // Without them ioredis dials in the background and `del` is issued before the
  // socket is ready; with `enableOfflineQueue` off there is nowhere to hold it,
  // so the command is rejected immediately and the purge never happened. The
  // timeout is also deliberately looser than the gateway's 100ms: that budget
  // belongs to a request path beside its own Redis, and this is a one-shot
  // command that may be run from a workstation through a tunnel.
  const redis = new Redis(redisUrl, {
    commandTimeout: 5_000,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    await redis.del(`aihub:v1:key:${hashHex}`, `aihub:v1:key:miss:${hashHex}`);
    console.error(`Revoked ${keyId} and purged its identity cache entry.`);
  } catch {
    console.error(
      `Revoked ${keyId}, but could not purge the identity cache; the key may still be accepted for up to 60 seconds.`,
    );
  } finally {
    // `disconnect` rather than `quit`: a client that never finished connecting
    // has no session to close politely, and waiting for one to answer is how
    // this command ends up hanging instead of reporting what it did.
    redis.disconnect();
  }
}

async function setIdentity(options) {
  const input = await parseIdentityOptions(options);
  const pool = await databasePool();
  try {
    const organization = await pool.query(
      'SELECT 1 FROM organizations WHERE id = $1',
      [input.organizationId],
    );
    if (organization.rowCount !== 1) {
      usageError();
    }

    const existingResult = await pool.query(
      `SELECT
         issuer,
         jwks_url,
         public_keys_jwks,
         allowed_algorithms,
         max_assertion_ttl_seconds,
         status
       FROM organization_identity_configs
       WHERE organization_id = $1`,
      [input.organizationId],
    );
    const existing = existingResult.rows[0];

    if (input.disableOnly) {
      if (existing === undefined) {
        usageError();
      }
      await pool.query(
        `UPDATE organization_identity_configs
         SET status = 'disabled', updated_at = now()
         WHERE organization_id = $1`,
        [input.organizationId],
      );
      console.log(input.organizationId);
      return;
    }

    const allowedAlgorithms =
      input.allowedAlgorithms ??
      (existing === undefined
        ? ['RS256', 'ES256']
        : existingIdentityAlgorithms(existing));
    const maxAssertionTtlSeconds =
      input.maxAssertionTtlSeconds ??
      (existing === undefined
        ? DEFAULT_ASSERTION_TTL_SECONDS
        : existingIdentityTtl(existing));
    const effectiveStatus =
      input.status ?? (existing === undefined ? 'active' : existing.status);
    if (effectiveStatus !== 'active' && effectiveStatus !== 'disabled') {
      usageError();
    }

    await pool.query(
      `INSERT INTO organization_identity_configs
         (organization_id, issuer, jwks_url, public_keys_jwks,
          allowed_algorithms, max_assertion_ttl_seconds, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (organization_id) DO UPDATE
       SET issuer = EXCLUDED.issuer,
           jwks_url = EXCLUDED.jwks_url,
           public_keys_jwks = EXCLUDED.public_keys_jwks,
           allowed_algorithms = EXCLUDED.allowed_algorithms,
           max_assertion_ttl_seconds = EXCLUDED.max_assertion_ttl_seconds,
           status = EXCLUDED.status,
           updated_at = now()`,
      [
        input.organizationId,
        input.issuer,
        input.jwksUrl,
        input.publicKeysJwks,
        allowedAlgorithms,
        maxAssertionTtlSeconds,
        effectiveStatus,
      ],
    );
    console.log(input.organizationId);
  } finally {
    await pool.end();
  }
}

async function cleanupIdempotency() {
  const pool = await databasePool();
  try {
    const result = await pool.query(
      `DELETE FROM idempotency_records
       WHERE expires_at <= now()
       RETURNING request_id`,
    );
    console.log(`Deleted ${result.rowCount} expired idempotency records`);
  } finally {
    await pool.end();
  }
}

async function reconcileQuotaCommand(options) {
  for (const name of options.keys()) {
    if (name !== 'month') {
      usageError();
    }
  }

  const requestedMonth = options.get('month');
  const now = new Date();
  await parseTargetMonth(requestedMonth, now);
  await runQuotaReconciliation({
    requestedMonth,
    now,
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? '',
  });
}

async function pruneUsageCommand(options) {
  if (options.size > 0) {
    usageError();
  }

  await runUsagePrune({
    databaseUrl: process.env.DATABASE_URL ?? '',
  });
}

async function reportUsageCommand(options) {
  for (const name of options.keys()) {
    if (name !== 'from' && name !== 'to') {
      usageError();
    }
  }

  await runUsageReport({
    databaseUrl: process.env.DATABASE_URL ?? '',
    from: requiredOption(options, 'from'),
    to: requiredOption(options, 'to'),
  });
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
  if (command === 'identity:set') {
    await setIdentity(options);
    return;
  }
  if (command === 'idempotency:cleanup') {
    await cleanupIdempotency();
    return;
  }
  if (command === 'quota:reconcile') {
    await reconcileQuotaCommand(options);
    return;
  }
  if (command === 'usage:prune') {
    await pruneUsageCommand(options);
    return;
  }
  if (command === 'usage:report') {
    await reportUsageCommand(options);
    return;
  }

  usageError();
}

main().catch((error) => {
  console.error('Command failed');
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
});
