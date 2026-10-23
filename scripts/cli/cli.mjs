import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import process, { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import { ulid } from 'ulid';

// The credential format is owned by the identity domain so that this CLI and
// the self-service endpoint cannot drift apart in prefix, entropy, or hashing.
const apiKeyModule = new URL(
  '../../dist/modules/identity/api-keys/application/organization-api-key-generator.js',
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
const prismaClientFactoryModule = new URL(
  '../../dist/modules/persistence/infrastructure/prisma-client.js',
  import.meta.url,
);
const idempotencyRepositoryModule = new URL(
  '../../dist/modules/idempotency/infrastructure/postgres-idempotency.repository.js',
  import.meta.url,
);
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
  environmentOption,
  quotaOption,
  usageError,
} from './cli-options.cjs';
import { loadCliRunner } from './load-cli-runner.cjs';

function cliRunnerDescriptor(name, exportName, unavailableMessage) {
  return {
    builtPath: fileURLToPath(
      new URL(`../../dist/cli/${name}.js`, import.meta.url),
    ),
    sourcePath: fileURLToPath(
      new URL(`../../src/cli/${name}.ts`, import.meta.url),
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
const avatarSweepDescriptor = cliRunnerDescriptor(
  'avatar-sweep',
  'runAvatarSweepCommand',
  'avatar sweep command is unavailable',
);
const notificationsSweepDescriptor = cliRunnerDescriptor(
  'notifications-sweep',
  'runNotificationsSweepCommand',
  'notifications sweep command is unavailable',
);
const registrationsSweepDescriptor = cliRunnerDescriptor(
  'registrations-sweep',
  'runRegistrationsSweepCommand',
  'registrations sweep command is unavailable',
);
const speakingAudioUploadSweepDescriptor = cliRunnerDescriptor(
  'speaking-audio-upload-sweep',
  'runSpeakingAudioUploadSweepCommand',
  'Speaking Audio upload sweep command is unavailable',
);
const writingChartUploadSweepDescriptor = cliRunnerDescriptor(
  'writing-chart-upload-sweep',
  'runWritingChartUploadSweepCommand',
  'Writing chart upload sweep command is unavailable',
);
const writingChartRevokeDescriptor = cliRunnerDescriptor(
  'writing-chart-revoke',
  'runWritingChartRevokeCommand',
  'Writing chart revocation command is unavailable',
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
const redisTtlAuditDescriptor = cliRunnerDescriptor(
  'redis-ttl-audit',
  'runRedisTtlAuditCommand',
  'Redis TTL audit command is unavailable',
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
const billingStatementDescriptor = cliRunnerDescriptor(
  'billing-statement',
  'runBillingStatementCommand',
  'billing statement command is unavailable',
);
const billingAdjustDescriptor = cliRunnerDescriptor(
  'billing-statement',
  'runBillingAdjustCommand',
  'billing adjustment command is unavailable',
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

function invalidQuotaMonth(error) {
  return (
    error instanceof Error &&
    error.name === 'InvalidQuotaReconciliationMonthError'
  );
}

async function parseTargetMonth(raw, now) {
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
  '../../dist/modules/secrets/infrastructure/runtime-connection.environment.js',
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
  loadRuntimeConnectionEnvironment({ env: process.env });
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
  return new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 300_000,
    lock_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
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
  // A new key is bound to one environment and issued under its display prefix.
  const environment = environmentOption(options, 'envs', 'production');
  const generated = generateApiKey(`ak_${ulid()}`, environment);

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
    allowedEnvironments: [environment],
    internal: booleanOption(options, 'internal'),
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
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  if (
    !existsSync(prismaClientFactoryModule) ||
    !existsSync(idempotencyRepositoryModule)
  ) {
    throw new Error(
      'Idempotency cleanup is unavailable. Run "pnpm build" before "idempotency:cleanup".',
    );
  }

  const [factoryModule, repositoryModule] = await Promise.all([
    import(prismaClientFactoryModule),
    import(idempotencyRepositoryModule),
  ]);
  const createOperatorPrismaClient =
    factoryModule.createOperatorPrismaClient ??
    factoryModule.default?.createOperatorPrismaClient;
  const PostgresIdempotencyRepository =
    repositoryModule.PostgresIdempotencyRepository ??
    repositoryModule.default?.PostgresIdempotencyRepository;
  if (
    typeof createOperatorPrismaClient !== 'function' ||
    typeof PostgresIdempotencyRepository !== 'function'
  ) {
    throw new Error('Idempotency cleanup is unavailable.');
  }
  const client = createOperatorPrismaClient('runtime', databaseUrl);
  try {
    const repository = new PostgresIdempotencyRepository(client.prisma);
    const deleted = await repository.cleanupExpired();
    console.log(`Deleted ${deleted} expired idempotency records`);
  } finally {
    await client.close();
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

async function auditRedisTtlCommand(options) {
  if (options.size > 0) {
    usageError();
  }

  const summary = await runCliCommand(redisTtlAuditDescriptor, {
    redisUrl: process.env.REDIS_URL ?? '',
  });
  if (summary.missingTtl > 0) {
    throw new Error('AIHUB Redis keys without TTL were detected');
  }
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

// Deletes Avatar objects that no record names once they are old enough
// (ADR-0068). `--dry-run true` reports without deleting. The summary is one
// JSON line, and any failed delete makes the exit status non-zero so cron
// alerts on a partial run. Run it once per deployment, like `usage:prune`.
async function sweepAvatarsCommand(options) {
  for (const name of options.keys()) {
    if (name !== 'dry-run') {
      usageError();
    }
  }

  const summary = await runCliCommand(avatarSweepDescriptor, {
    databaseUrl: process.env.DATABASE_URL ?? '',
    dryRun: booleanOption(options, 'dry-run'),
  });
  if (summary.failed > 0) {
    throw new Error('avatar sweep could not delete every orphaned object');
  }
}

// Records a Notification Event for each API key expiring within 14 days and
// queues its email (ADR-0120). The summary is one JSON line of counts; a
// failure leaves the exit status non-zero so cron alerts. Run it daily.
async function sweepRegistrationsCommand(options) {
  if (options.size > 0) {
    usageError();
  }

  await runCliCommand(registrationsSweepDescriptor, {
    databaseUrl: process.env.DATABASE_URL ?? '',
  });
}

async function sweepNotificationsCommand(options) {
  if (options.size > 0) {
    usageError();
  }

  await runCliCommand(notificationsSweepDescriptor, {
    databaseUrl: process.env.DATABASE_URL ?? '',
  });
}

async function sweepSpeakingAudioUploadsCommand(options) {
  for (const name of options.keys()) {
    if (name !== 'dry-run') {
      usageError();
    }
  }

  const summary = await runCliCommand(speakingAudioUploadSweepDescriptor, {
    databaseUrl: process.env.DATABASE_URL ?? '',
    dryRun: booleanOption(options, 'dry-run'),
  });
  if (summary.failed > 0) {
    throw new Error(
      'Speaking Audio upload sweep could not delete every object',
    );
  }
}

async function sweepWritingChartUploadsCommand(options) {
  for (const name of options.keys()) {
    if (name !== 'dry-run') usageError();
  }
  const summary = await runCliCommand(writingChartUploadSweepDescriptor, {
    databaseUrl: process.env.DATABASE_URL ?? '',
    dryRun: booleanOption(options, 'dry-run'),
  });
  if (summary.failed > 0) {
    throw new Error('Writing chart upload sweep could not delete every object');
  }
}

async function revokeWritingChartCommand(options) {
  for (const name of options.keys()) {
    if (name !== 'url' && name !== 'actor') usageError();
  }
  const environment =
    process.env.AIHUB_RUNTIME_DATABASE_SCOPE?.trim() || 'production';
  if (environment !== 'production' && environment !== 'sandbox') usageError();
  let result;
  try {
    result = await runCliCommand(writingChartRevokeDescriptor, {
      databaseUrl: process.env.DATABASE_URL ?? '',
      environment,
      url: requiredOption(options, 'url'),
      actorUsername: requiredOption(options, 'actor'),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      ['INVALID_PUBLIC_URL', 'ACTOR_INVALID'].includes(error.code)
    ) {
      usageError();
    }
    throw error;
  }
  if (result.origin === 'failed') {
    throw new Error('Writing chart origin deletion failed');
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

function invalidBillingInput(error) {
  return (
    error instanceof Error &&
    typeof error.code === 'string' &&
    (error.code === 'BILLING_INVALID_MONTH' ||
      error.code === 'BILLING_INVALID_ADJUSTMENT' ||
      error.code === 'BILLING_MONTH_NOT_ENDED')
  );
}

async function runBilling(descriptor, input) {
  try {
    return await runCliCommand(descriptor, input);
  } catch (error) {
    if (invalidBillingInput(error)) {
      usageError();
    }
    throw error;
  }
}

// billing:statement --month YYYY-MM [--org <id>] [--close true --actor <username>]
async function billingStatementCommand(options) {
  for (const name of options.keys()) {
    if (!['month', 'org', 'close', 'actor'].includes(name)) {
      usageError();
    }
  }
  const close = booleanOption(options, 'close');
  if (close !== options.has('actor')) {
    usageError();
  }
  await runBilling(billingStatementDescriptor, {
    databaseUrl: process.env.DATABASE_URL ?? '',
    month: requiredOption(options, 'month'),
    ...(options.has('org')
      ? { organizationId: requiredOption(options, 'org') }
      : {}),
    ...(close ? { closeAs: requiredOption(options, 'actor') } : {}),
  });
}

// billing:adjust --org <id> --month YYYY-MM --operation <id> --requests <+/-n>
//   --reason <text> --actor <username>
//   (--request-ids <id,id> | --period-from <iso> --period-to <iso>)
async function billingAdjustCommand(options) {
  const allowed = [
    'org',
    'month',
    'operation',
    'requests',
    'reason',
    'actor',
    'request-ids',
    'period-from',
    'period-to',
  ];
  for (const name of options.keys()) {
    if (!allowed.includes(name)) {
      usageError();
    }
  }
  const byIds = options.has('request-ids');
  const byPeriod = options.has('period-from') || options.has('period-to');
  if (byIds === byPeriod) {
    usageError();
  }
  const rawRequests = requiredOption(options, 'requests');
  if (!/^[+-]?[1-9][0-9]{0,8}$/.test(rawRequests)) {
    usageError();
  }
  await runBilling(billingAdjustDescriptor, {
    databaseUrl: process.env.DATABASE_URL ?? '',
    organizationId: requiredOption(options, 'org'),
    month: requiredOption(options, 'month'),
    operation: requiredOption(options, 'operation'),
    requests: Number(rawRequests),
    reason: requiredOption(options, 'reason'),
    actor: requiredOption(options, 'actor'),
    corrects: byIds
      ? { requestIds: listOption(options, 'request-ids', '') }
      : {
          period: {
            from: requiredOption(options, 'period-from'),
            to: requiredOption(options, 'period-to'),
          },
        },
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
  if (command === 'redis:ttl-audit') {
    await auditRedisTtlCommand(options);
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
  if (command === 'avatar:sweep') {
    await sweepAvatarsCommand(options);
    return;
  }
  if (command === 'speaking:audio-upload-sweep') {
    await sweepSpeakingAudioUploadsCommand(options);
    return;
  }
  if (command === 'registrations:sweep') {
    await sweepRegistrationsCommand(options);
    return;
  }
  if (command === 'notifications:sweep') {
    await sweepNotificationsCommand(options);
    return;
  }
  if (command === 'writing:chart-upload-sweep') {
    await sweepWritingChartUploadsCommand(options);
    return;
  }
  if (command === 'writing:chart-revoke') {
    await revokeWritingChartCommand(options);
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
  if (command === 'billing:statement') {
    await billingStatementCommand(options);
    return;
  }
  if (command === 'billing:adjust') {
    await billingAdjustCommand(options);
    return;
  }

  usageError();
}

main().catch((error) => {
  console.error(
    error instanceof Error && error.code === 'AUDIT_COMPLETION_FAILURE'
      ? 'Revocation outcome is unconfirmed: the request is audited, but completion could not be confirmed. After database recovery, rerun the same URL and actor; deletion is idempotent.'
      : 'Command failed',
  );
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
});
