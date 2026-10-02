import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import { ulid } from 'ulid';

// The credential format is owned by the identity domain so that this CLI and
// the self-service endpoint cannot drift apart in prefix, entropy, or hashing.
const apiKeyModule = new URL(
  '../dist/modules/identity/domain/api-key.js',
  import.meta.url,
);

async function loadApiKeyGenerator() {
  if (!existsSync(apiKeyModule)) {
    throw new Error(
      'The API key generator is unavailable. Run "pnpm build" before "key:create".',
    );
  }

  const module = await import(apiKeyModule);
  const generateApiKey =
    module.generateApiKey ?? module.default?.generateApiKey;
  if (typeof generateApiKey !== 'function') {
    throw new Error('The API key generator is unavailable.');
  }
  return generateApiKey;
}
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
import { loadCliRunner } from './load-cli-runner.cjs';

function cliRunnerDescriptor(name, exportName, unavailableMessage) {
  return {
    builtPath: fileURLToPath(
      new URL(`../dist/cli/${name}.js`, import.meta.url),
    ),
    sourcePath: fileURLToPath(
      new URL(`../src/cli/${name}.ts`, import.meta.url),
    ),
    exportName,
    unavailableMessage,
  };
}

const organizationStatusDescriptor = cliRunnerDescriptor(
  'organization-status',
  'runOrganizationStatusCommand',
  'organization status command is unavailable',
);
const organizationEntitlementDescriptor = cliRunnerDescriptor(
  'organization-entitlement',
  'runGrantOrganizationEntitlementCommand',
  'organization entitlement command is unavailable',
);
const attachFirstOwnerDescriptor = cliRunnerDescriptor(
  'organization-first-owner',
  'runAttachFirstOwnerCommand',
  'first owner attachment command is unavailable',
);
const usagePruneDescriptor = cliRunnerDescriptor(
  'usage-prune',
  'runUsagePruneCommand',
  'usage prune command is unavailable',
);
const usageReportDescriptor = cliRunnerDescriptor(
  'usage-report',
  'runUsageReportCommand',
  'usage report command is unavailable',
);
const quotaReconciliationDescriptor = cliRunnerDescriptor(
  'quota-reconcile',
  'runQuotaReconciliationCommand',
  'quota reconciliation command is unavailable',
);
const createOperatorApiKeyDescriptor = cliRunnerDescriptor(
  'organization-api-key',
  'runCreateOperatorApiKeyCommand',
  'operator API key command is unavailable',
);
const revokeOperatorApiKeyDescriptor = cliRunnerDescriptor(
  'organization-api-key',
  'runRevokeOperatorApiKeyCommand',
  'operator API key command is unavailable',
);
const quotaTargetMonthDescriptor = cliRunnerDescriptor(
  'quota-reconcile',
  'parseTargetMonth',
  'quota reconciliation command is unavailable',
);

async function runCliCommand(descriptor, ...args) {
  const runner = await loadCliRunner(descriptor);
  return runner(...args);
}

async function runOrganizationStatus(input) {
  return runCliCommand(organizationStatusDescriptor, input);
}

async function runGrantOrganizationEntitlement(input) {
  return runCliCommand(organizationEntitlementDescriptor, input);
}

async function runAttachFirstOwner(input) {
  return runCliCommand(attachFirstOwnerDescriptor, input);
}

async function runUsagePrune(input) {
  return runCliCommand(usagePruneDescriptor, input);
}

function invalidUsageReportWindow(error) {
  return (
    error instanceof Error &&
    error.message === 'usage report window is invalid' &&
    error.code === 'USAGE_REPORT_INVALID_WINDOW'
  );
}

async function runUsageReport(input) {
  try {
    return await runCliCommand(usageReportDescriptor, input);
  } catch (error) {
    if (invalidUsageReportWindow(error)) {
      usageError();
    }
    throw error;
  }
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function invalidQuotaMonth(error) {
  return (
    error instanceof Error &&
    error.name === 'InvalidQuotaReconciliationMonthError'
  );
}

async function parseTargetMonth(raw, now) {
  if (raw !== undefined && !MONTH_PATTERN.test(raw)) {
    usageError();
  }

  try {
    return await runCliCommand(quotaTargetMonthDescriptor, raw, now);
  } catch (error) {
    if (invalidQuotaMonth(error)) {
      usageError();
    }
    throw error;
  }
}

async function runQuotaReconciliation(input) {
  try {
    return await runCliCommand(quotaReconciliationDescriptor, input);
  } catch (error) {
    if (invalidQuotaMonth(error)) {
      usageError();
    }
    throw error;
  }
}

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

async function databasePool({ controlPlane = false } = {}) {
  const databaseUrl = controlPlane
    ? (process.env.CONTROL_PLANE_DATABASE_URL ?? process.env.DATABASE_URL)
    : process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: databaseUrl });
}

async function createOrganization(options) {
  const pool = await databasePool({ controlPlane: true });
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

// Operator key issuance and revocation record an Organization Audit Event, so
// both need `--actor`: the operator's own AIHUB User Account (ADR-0044). The
// raw key is generated here and handed to the runner, which prints it after
// commit; stdout stays exactly the raw key because `demo-bootstrap` captures it.
function controlPlaneDatabaseUrl() {
  return (
    process.env.CONTROL_PLANE_DATABASE_URL ?? process.env.DATABASE_URL ?? ''
  );
}

async function createKey(options) {
  const generateApiKey = await loadApiKeyGenerator();
  const organizationId = requiredOption(options, 'org');
  const actorUsername = requiredOption(options, 'actor');
  const name = requiredOption(options, 'name');
  const scopes = listOption(options, 'scopes', 'writing.grade');
  const allowedEnvironments = environmentListOption(
    options,
    'envs',
    'production',
  );
  const generated = generateApiKey(`ak_${ulid()}`);

  const outcome = await runCliCommand(createOperatorApiKeyDescriptor, {
    databaseUrl: controlPlaneDatabaseUrl(),
    organizationId,
    actorUsername,
    credential: {
      id: generated.id,
      hash: generated.hash,
      prefix: generated.prefix,
      raw: generated.raw,
    },
    name,
    scopes,
    allowedEnvironments,
  });
  if (outcome !== 'created') {
    usageError();
  }
}

async function revokeKey(options) {
  const outcome = await runCliCommand(revokeOperatorApiKeyDescriptor, {
    databaseUrl: controlPlaneDatabaseUrl(),
    redisUrl: process.env.REDIS_URL,
    apiKeyId: requiredOption(options, 'key'),
    actorUsername: requiredOption(options, 'actor'),
  });
  if (outcome !== 'revoked' && outcome !== 'unchanged') {
    usageError();
  }
}

async function setIdentity(options) {
  const input = await parseIdentityOptions(options);
  const pool = await databasePool({ controlPlane: true });
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

// Suspension and restoration are operator acts with no Bearer route
// (ADR-0044). `--actor` names the operator's own AIHUB User Account, which the
// audit event records; an unknown Organization or actor is a usage error, so
// scripts can tell a bad command from an operational failure.
async function organizationStatusCommand(options, status) {
  for (const name of options.keys()) {
    if (name !== 'org' && name !== 'actor') {
      usageError();
    }
  }

  const outcome = await runOrganizationStatus({
    databaseUrl:
      process.env.CONTROL_PLANE_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL,
    organizationId: requiredOption(options, 'org'),
    actorUsername: requiredOption(options, 'actor'),
    status,
  });
  if (outcome === 'organization_not_found' || outcome === 'actor_invalid') {
    usageError();
  }
}

async function organizationGrantEntitlementCommand(options) {
  for (const name of options.keys()) {
    if (name !== 'org' && name !== 'actor' && name !== 'entitlement')
      usageError();
  }
  const outcome = await runGrantOrganizationEntitlement({
    databaseUrl:
      process.env.CONTROL_PLANE_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL,
    organizationId: requiredOption(options, 'org'),
    actorUsername: requiredOption(options, 'actor'),
    entitlement: requiredOption(options, 'entitlement'),
  });
  if (!['granted', 'unchanged'].includes(outcome)) usageError();
}

// First Owner Attachment (ADR-0045): the bootstrap for an Organization
// `org:create` provisioned, which starts with no members. Every refusal is a
// usage error, named by the command before it exits.
async function attachFirstOwnerCommand(options) {
  for (const name of options.keys()) {
    if (name !== 'org' && name !== 'owner' && name !== 'actor') {
      usageError();
    }
  }

  const outcome = await runAttachFirstOwner({
    databaseUrl:
      process.env.CONTROL_PLANE_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
    organizationId: requiredOption(options, 'org'),
    ownerUsername: requiredOption(options, 'owner'),
    actorUsername: requiredOption(options, 'actor'),
  });
  if (outcome !== 'attached' && outcome !== 'unchanged') {
    usageError();
  }
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
  if (command === 'org:attach-owner') {
    await attachFirstOwnerCommand(options);
    return;
  }
  if (command === 'org:suspend') {
    await organizationStatusCommand(options, 'suspended');
    return;
  }
  if (command === 'org:restore') {
    await organizationStatusCommand(options, 'active');
    return;
  }
  if (command === 'org:grant-entitlement') {
    await organizationGrantEntitlementCommand(options);
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
