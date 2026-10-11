import { Buffer } from 'node:buffer';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../../dist/generated/prisma/client.js');
const {
  apiKeys,
  organizations,
} = require('../../dist/modules/identity/shared/infrastructure/drizzle-identity-schema.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ORGANIZATION_COUNT = 100;
const ORGANIZATION_ID = `bench_org_${String(ORGANIZATION_COUNT - 1).padStart(3, '0')}`;
const API_KEY_COUNT = 100_000;
const USAGE_RECORD_COUNT = 1_000_000;
const PASS_DURATION_MS = 5_000;
const OPERATIONS_PER_SECOND = 50;
const OPERATIONS_PER_PASS = (PASS_DURATION_MS / 1_000) * OPERATIONS_PER_SECOND;
const LOOKUP_KEY_ID = `bench_key_${String(API_KEY_COUNT).padStart(6, '0')}`;
const LOOKUP_HASH = Buffer.alloc(32);
LOOKUP_HASH.writeBigUInt64BE(BigInt(API_KEY_COUNT), 24);

const usageRecords = pgTable('usage_records', {
  requestId: text('request_id'),
  organizationId: text('organization_id'),
  apiKeyId: text('api_key_id'),
  actorId: text('actor_id'),
  service: text('service'),
  operation: text('operation'),
  environment: text('environment'),
  outcome: text('outcome'),
  httpStatus: integer('http_status'),
  errorCode: text('error_code'),
  billableRequests: integer('billable_requests'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  totalTokens: integer('total_tokens'),
  models: jsonb('models'),
  meteringStatus: text('metering_status'),
  totalMs: integer('total_ms'),
  downstreamMs: integer('downstream_ms'),
  aiProcessingMs: integer('ai_processing_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

const API_KEY_LOOKUP_SQL = `
  SELECT
    api.organization_id AS organization_id,
    api.id AS api_key_id,
    org.status AS organization_status,
    api.status AS status,
    api.scopes AS scopes,
    org.entitlements AS entitlements,
    api.allowed_environments AS allowed_environments,
    api.expires_at AS expires_at,
    org.rate_limit_rpm AS rate_limit_rpm,
    org.max_concurrent AS max_concurrent,
    org.monthly_request_quota AS monthly_request_quota,
    org.hard_stop_on_quota AS hard_stop_on_quota
  FROM api_keys AS api
  INNER JOIN organizations AS org ON org.id = api.organization_id
  WHERE api.key_hash = $1
  LIMIT 1
`;

const METERING_INSERT_SQL = `
  INSERT INTO usage_records (
    request_id, organization_id, api_key_id, actor_id, service, operation,
    environment, outcome, http_status, error_code, billable_requests,
    input_tokens, output_tokens, total_tokens, models, metering_status,
    total_ms, downstream_ms, ai_processing_ms
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19)
  ON CONFLICT (request_id) DO NOTHING
  RETURNING request_id
`;

const USAGE_AGGREGATE_SQL = `
  SELECT
    COALESCE(SUM(billable_requests) FILTER (WHERE outcome = 'success'), 0)::bigint AS billable_request_count,
    COALESCE(SUM(total_tokens) FILTER (WHERE outcome = 'success' AND billable_requests = 1), 0)::bigint AS billable_token_count,
    COUNT(*) FILTER (WHERE outcome = 'success' AND metering_status = 'missing_usage')::bigint AS missing_usage_count
  FROM usage_records
  WHERE organization_id = $1
    AND created_at >= $2
    AND created_at < $3
    AND ($4::text IS NULL OR operation = $4)
`;

function assertDisposableAdminUrl(connectionString) {
  const url = new URL(connectionString);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '5433' ||
    url.pathname !== '/postgres'
  ) {
    throw new Error(
      'Benchmark requires the disposable local PostgreSQL admin URL on port 5433 and database postgres',
    );
  }
  return url;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function instrumentPool(pool) {
  let statements = 0;
  const wrapped = new WeakSet();
  pool.on('acquire', (client) => {
    if (wrapped.has(client)) {
      return;
    }
    wrapped.add(client);
    const query = client.query.bind(client);
    client.query = (...args) => {
      statements += 1;
      return query(...args);
    };
  });
  return {
    reset: () => {
      statements = 0;
    },
    count: () => statements,
  };
}

function apiKeyOutput(row) {
  if (row === null || row === undefined) {
    return null;
  }
  return {
    organizationId: row.organizationId,
    apiKeyId: row.apiKeyId,
    organizationStatus: row.organizationStatus,
    status: row.status,
    scopes: row.scopes,
    entitlements: row.entitlements,
    allowedEnvironments: row.allowedEnvironments,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    rateLimitRpm: row.rateLimitRpm,
    maxConcurrent: row.maxConcurrent,
    monthlyRequestQuota: row.monthlyRequestQuota,
    hardStopOnQuota: row.hardStopOnQuota,
  };
}

function rawApiKeyOutput(row) {
  if (row === null || row === undefined) {
    return null;
  }
  return apiKeyOutput({
    organizationId: row.organization_id,
    apiKeyId: row.api_key_id,
    organizationStatus: row.organization_status,
    status: row.status,
    scopes: row.scopes,
    entitlements: row.entitlements,
    allowedEnvironments: row.allowed_environments,
    expiresAt: row.expires_at,
    rateLimitRpm: row.rate_limit_rpm,
    maxConcurrent: row.max_concurrent,
    monthlyRequestQuota: row.monthly_request_quota,
    hardStopOnQuota: row.hard_stop_on_quota,
  });
}

function prismaApiKeyOutput(row) {
  if (row === null || row === undefined) {
    return null;
  }
  return apiKeyOutput({
    organizationId: row.organizationId,
    apiKeyId: row.id,
    organizationStatus: row.organization.status,
    status: row.status,
    scopes: row.scopes,
    entitlements: row.organization.entitlements,
    allowedEnvironments: row.allowedEnvironments,
    expiresAt: row.expiresAt,
    rateLimitRpm: row.organization.rateLimitRpm,
    maxConcurrent: row.organization.maxConcurrent,
    monthlyRequestQuota: row.organization.monthlyRequestQuota,
    hardStopOnQuota: row.organization.hardStopOnQuota,
  });
}

function meteringInsertOutput(rows) {
  return rows.map((row) => ({
    requestId: row.request_id ?? row.requestId,
  }));
}

function usageRecord(requestId) {
  return {
    requestId,
    organizationId: ORGANIZATION_ID,
    apiKeyId: LOOKUP_KEY_ID,
    actorId: null,
    service: 'ai-speaking',
    operation: 'speaking.grade',
    environment: 'production',
    outcome: 'success',
    httpStatus: 200,
    errorCode: null,
    billableRequests: 1,
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
    models: null,
    meteringStatus: 'complete',
    totalMs: 20,
    downstreamMs: 18,
    aiProcessingMs: 18,
  };
}

function usageRecordValues(record) {
  return [
    record.requestId,
    record.organizationId,
    record.apiKeyId,
    record.actorId,
    record.service,
    record.operation,
    record.environment,
    record.outcome,
    record.httpStatus,
    record.errorCode,
    record.billableRequests,
    record.inputTokens,
    record.outputTokens,
    record.totalTokens,
    record.models,
    record.meteringStatus,
    record.totalMs,
    record.downstreamMs,
    record.aiProcessingMs,
  ];
}

function aggregateOutput(row) {
  return {
    billableRequestCount: String(row.billable_request_count),
    billableTokenCount: String(row.billable_token_count),
    missingUsageCount: String(row.missing_usage_count),
  };
}

function canonical(value) {
  return JSON.stringify(value);
}

async function applyMigrations(databaseUrl) {
  const migrationsDirectory = join(ROOT, 'database/migrations');
  const files = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    for (const filename of files) {
      await pool.query(
        await readFile(join(migrationsDirectory, filename), 'utf8'),
      );
    }
  } finally {
    await pool.end();
  }
}

async function seedDatabase(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query(`
      INSERT INTO organizations (id, name, status, entitlements)
      SELECT
        'bench_org_' || lpad(n::text, 3, '0'),
        'Prisma benchmark ' || n::text,
        'active',
        ARRAY['speaking', 'writing']
      FROM generate_series(0, ${ORGANIZATION_COUNT - 1}) AS n
    `);
    await pool.query(`
      INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, name)
      SELECT
        'bench_key_' || lpad(n::text, 6, '0'),
        'bench_org_' || lpad(((n - 1) % ${ORGANIZATION_COUNT})::text, 3, '0'),
        decode(lpad(to_hex(n::bigint), 64, '0'), 'hex'),
        'bench',
        'Benchmark key'
      FROM generate_series(1, ${API_KEY_COUNT}) AS n
    `);
    await pool.query(`
      INSERT INTO usage_records (
        request_id, organization_id, api_key_id, service, operation,
        environment, outcome, http_status, error_code, billable_requests,
        input_tokens, output_tokens, total_tokens, metering_status, total_ms,
        downstream_ms, ai_processing_ms, created_at
      )
      SELECT
        'bench_usage_' || lpad(n::text, 7, '0'),
        'bench_org_' || lpad(((n - 1) % ${ORGANIZATION_COUNT})::text, 3, '0'),
        'bench_key_' || lpad((((n - 1) % ${API_KEY_COUNT}) + 1)::text, 6, '0'),
        'ai-speaking',
        'speaking.grade',
        'production',
        CASE WHEN n % 5 = 0 THEN 'downstream_error' ELSE 'success' END,
        CASE WHEN n % 5 = 0 THEN 502 ELSE 200 END,
        CASE WHEN n % 5 = 0 THEN 'AI_SERVICE_ERROR' ELSE NULL END,
        CASE WHEN n % 5 = 0 THEN 0 ELSE 1 END,
        CASE WHEN n % 5 = 0 OR n % 29 = 0 THEN NULL ELSE (n % 50)::integer END,
        CASE WHEN n % 5 = 0 OR n % 29 = 0 THEN NULL ELSE (n % 50)::integer END,
        CASE WHEN n % 5 = 0 OR n % 29 = 0 THEN NULL ELSE (n % 100)::integer END,
        CASE WHEN n % 5 <> 0 AND n % 29 = 0 THEN 'missing_usage' ELSE 'complete' END,
        (n % 1_000)::integer,
        (n % 900)::integer,
        (n % 900)::integer,
        now() - interval '1 minute'
      FROM generate_series(1, ${USAGE_RECORD_COUNT}) AS n
    `);
    await pool.query('ANALYZE api_keys; ANALYZE usage_records');
    const counts = await pool.query(`
      SELECT
        (SELECT count(*) FROM api_keys) AS api_keys,
        (SELECT count(*) FROM usage_records) AS usage_records
    `);
    return {
      apiKeys: Number(counts.rows[0].api_keys),
      usageRecords: Number(counts.rows[0].usage_records),
    };
  } finally {
    await pool.end();
  }
}

function makeModes(databaseUrl) {
  const sharedPool = new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
  const sharedMetrics = instrumentPool(sharedPool);
  const drizzleClient = drizzle(sharedPool, {
    schema: { apiKeys, organizations },
  });

  const prismaPool = new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
  const prismaMetrics = instrumentPool(prismaPool);
  const prismaClient = new PrismaClient({ adapter: new PrismaPg(prismaPool) });

  const raw = {
    metrics: sharedMetrics,
    normalizeApiKey: rawApiKeyOutput,
    normalizeMeteringInsert: meteringInsertOutput,
    normalizeUsageAggregate: aggregateOutput,
    async apiKeyLookup() {
      const result = await sharedPool.query(API_KEY_LOOKUP_SQL, [LOOKUP_HASH]);
      return result.rows[0] ?? null;
    },
    async meteringInsert(requestId) {
      const result = await sharedPool.query(
        METERING_INSERT_SQL,
        usageRecordValues(usageRecord(requestId)),
      );
      return result.rows;
    },
    async usageAggregate(from, to) {
      const result = await sharedPool.query(USAGE_AGGREGATE_SQL, [
        ORGANIZATION_ID,
        from,
        to,
        null,
      ]);
      return result.rows[0];
    },
  };

  const drizzleMode = {
    metrics: sharedMetrics,
    normalizeApiKey: apiKeyOutput,
    normalizeMeteringInsert: meteringInsertOutput,
    normalizeUsageAggregate: aggregateOutput,
    async apiKeyLookup() {
      const rows = await drizzleClient
        .select({
          organizationId: apiKeys.organizationId,
          apiKeyId: apiKeys.id,
          organizationStatus: organizations.status,
          status: apiKeys.status,
          scopes: apiKeys.scopes,
          entitlements: organizations.entitlements,
          allowedEnvironments: apiKeys.allowedEnvironments,
          expiresAt: apiKeys.expiresAt,
          rateLimitRpm: organizations.rateLimitRpm,
          maxConcurrent: organizations.maxConcurrent,
          monthlyRequestQuota: organizations.monthlyRequestQuota,
          hardStopOnQuota: organizations.hardStopOnQuota,
        })
        .from(apiKeys)
        .innerJoin(organizations, eq(organizations.id, apiKeys.organizationId))
        .where(eq(apiKeys.keyHash, LOOKUP_HASH))
        .limit(1);
      return rows[0] ?? null;
    },
    async meteringInsert(requestId) {
      const record = usageRecord(requestId);
      const rows = await drizzleClient
        .insert(usageRecords)
        .values(record)
        .onConflictDoNothing({ target: usageRecords.requestId })
        .returning({ requestId: usageRecords.requestId });
      return rows;
    },
    async usageAggregate(from, to) {
      const rows = await drizzleClient
        .select({
          billable_request_count: sql`COALESCE(SUM(${usageRecords.billableRequests}) FILTER (WHERE ${usageRecords.outcome} = 'success'), 0)::bigint`,
          billable_token_count: sql`COALESCE(SUM(${usageRecords.totalTokens}) FILTER (WHERE ${usageRecords.outcome} = 'success' AND ${usageRecords.billableRequests} = 1), 0)::bigint`,
          missing_usage_count: sql`COUNT(*) FILTER (WHERE ${usageRecords.outcome} = 'success' AND ${usageRecords.meteringStatus} = 'missing_usage')::bigint`,
        })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.organizationId, ORGANIZATION_ID),
            gte(usageRecords.createdAt, from),
            lt(usageRecords.createdAt, to),
            sql`(${null}::text IS NULL OR ${usageRecords.operation} = ${null})`,
          ),
        );
      return rows[0];
    },
  };

  const prisma = {
    metrics: prismaMetrics,
    normalizeApiKey: prismaApiKeyOutput,
    normalizeMeteringInsert: meteringInsertOutput,
    normalizeUsageAggregate: aggregateOutput,
    async apiKeyLookup() {
      const row = await prismaClient.apiKey.findUnique({
        where: { keyHash: LOOKUP_HASH },
        select: {
          id: true,
          organizationId: true,
          status: true,
          scopes: true,
          allowedEnvironments: true,
          expiresAt: true,
          organization: {
            select: {
              status: true,
              entitlements: true,
              rateLimitRpm: true,
              maxConcurrent: true,
              monthlyRequestQuota: true,
              hardStopOnQuota: true,
            },
          },
        },
      });
      return row;
    },
    async meteringInsert(requestId) {
      const record = usageRecord(requestId);
      const {
        actorId: _actorId,
        errorCode: _errorCode,
        models: _models,
        ...data
      } = record;
      const rows = await prismaClient.usageRecord.createManyAndReturn({
        data: [data],
        skipDuplicates: true,
        select: { requestId: true },
      });
      return rows;
    },
    async usageAggregate(from, to) {
      const rows = await prismaClient.$queryRawUnsafe(
        USAGE_AGGREGATE_SQL,
        ORGANIZATION_ID,
        from,
        to,
        null,
      );
      return rows[0];
    },
  };

  for (const [modeName, mode] of Object.entries({
    raw,
    drizzle: drizzleMode,
    prisma,
  })) {
    mode.apiKeyLookup = mode.apiKeyLookup.bind(mode);
    mode.meteringInsert = mode.meteringInsert.bind(mode);
    mode.usageAggregate = mode.usageAggregate.bind(mode);
    mode.name = modeName;
  }

  return {
    raw,
    drizzle: drizzleMode,
    prisma,
    async close() {
      await prismaClient.$disconnect();
      await Promise.all([sharedPool.end(), prismaPool.end()]);
    },
  };
}

async function verifyOutputs(modes, from, to, cleanupPool) {
  const operationResults = new Map();
  const fixtureRequestId = 'bench_verify_523';

  for (const modeName of ['raw', 'drizzle', 'prisma']) {
    const mode = modes[modeName];
    const rawApiKey = await mode.apiKeyLookup();
    const outputs = {
      apiKeyLookup: mode.normalizeApiKey(rawApiKey),
      meteringInsert: undefined,
      lookupThenInsert: undefined,
      usageAggregate: mode.normalizeUsageAggregate(
        await mode.usageAggregate(from, to),
      ),
    };

    await cleanupPool.query('DELETE FROM usage_records WHERE request_id = $1', [
      fixtureRequestId,
    ]);
    outputs.meteringInsert = mode.normalizeMeteringInsert(
      await mode.meteringInsert(fixtureRequestId),
    );
    await cleanupPool.query('DELETE FROM usage_records WHERE request_id = $1', [
      fixtureRequestId,
    ]);
    const apiKey = mode.normalizeApiKey(await mode.apiKeyLookup());
    const inserted = mode.normalizeMeteringInsert(
      await mode.meteringInsert(fixtureRequestId),
    );
    outputs.lookupThenInsert = { apiKey, inserted };
    await cleanupPool.query('DELETE FROM usage_records WHERE request_id = $1', [
      fixtureRequestId,
    ]);

    if (outputs.apiKeyLookup?.apiKeyId !== LOOKUP_KEY_ID) {
      throw new Error(`${modeName} API-key lookup returned the wrong fixture`);
    }
    if (outputs.meteringInsert[0]?.requestId !== fixtureRequestId) {
      throw new Error(`${modeName} Metering insert did not return its fixture`);
    }
    if (outputs.lookupThenInsert.inserted[0]?.requestId !== fixtureRequestId) {
      throw new Error(
        `${modeName} lookup-then-insert did not return its fixture`,
      );
    }
    operationResults.set(modeName, outputs);
  }

  const baseline = operationResults.get('raw');
  for (const [modeName, result] of operationResults) {
    if (canonical(result) !== canonical(baseline)) {
      throw new Error(`Output mismatch between raw pg and ${modeName}`);
    }
  }
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function runPass(mode, operation, passNumber) {
  mode.metrics.reset();
  const samples = [];
  let failures = 0;
  const tasks = [];
  const startedAt = performance.now();

  for (let index = 0; index < OPERATIONS_PER_PASS; index += 1) {
    const dueAt = startedAt + (index * 1_000) / OPERATIONS_PER_SECOND;
    const delay = dueAt - performance.now();
    if (delay > 0) {
      await sleep(delay);
    }
    const operationStartedAt = performance.now();
    const requestId = `bench_523_${mode.name}_${operation.name}_${passNumber}_${index}`;
    tasks.push(
      (async () => {
        try {
          if (operation.name === 'apiKeyLookup') {
            await mode.apiKeyLookup();
          } else if (operation.name === 'meteringInsert') {
            await mode.meteringInsert(requestId);
          } else if (operation.name === 'lookupThenInsert') {
            await mode.apiKeyLookup();
            await mode.meteringInsert(requestId);
          } else {
            await mode.usageAggregate(operation.from, operation.to);
          }
          samples.push(performance.now() - operationStartedAt);
        } catch (error) {
          failures += 1;
          if (failures === 1) {
            process.stderr.write(
              `${mode.name}/${operation.name}: ${String(error)}\n`,
            );
          }
        }
      })(),
    );
  }

  await Promise.all(tasks);
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  const statementCount = mode.metrics.count();

  return {
    p50: samples.length === 0 ? null : percentile(samples, 0.5),
    p95: samples.length === 0 ? null : percentile(samples, 0.95),
    completedRate: samples.length / elapsedSeconds,
    roundTrips: samples.length === 0 ? null : statementCount / samples.length,
    failures,
  };
}

function range(values) {
  const finiteValues = values.filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
  if (finiteValues.length === 0) {
    return 'n/a';
  }
  const minimum = Math.min(...finiteValues);
  const maximum = Math.max(...finiteValues);
  return minimum.toFixed(2) === maximum.toFixed(2)
    ? minimum.toFixed(2)
    : `${minimum.toFixed(2)}–${maximum.toFixed(2)}`;
}

function renderResults(results, operations) {
  const modes = ['raw', 'drizzle', 'prisma'];
  const rows = operations.map((operation) => {
    const cell = (modeName) => {
      const passes = results.get(`${modeName}:${operation.name}`);
      const p50 = range(passes.map((pass) => pass.p50));
      const p95 = range(passes.map((pass) => pass.p95));
      return `${p50} / ${p95}`;
    };
    const rates = modes
      .map((modeName) => {
        const passes = results.get(`${modeName}:${operation.name}`);
        return range(passes.map((pass) => pass.completedRate));
      })
      .join(' / ');
    const roundTrips = modes
      .map((modeName) => {
        const passes = results.get(`${modeName}:${operation.name}`);
        return range(passes.map((pass) => pass.roundTrips));
      })
      .join(' / ');
    const failures = modes
      .map((modeName) => {
        const passes = results.get(`${modeName}:${operation.name}`);
        return range(passes.map((pass) => pass.failures));
      })
      .join(' / ');
    return `| ${operation.label} | ${roundTrips} | ${cell('raw')} | ${cell('drizzle')} | ${cell('prisma')} | ${rates} | ${failures} |`;
  });
  process.stdout.write(
    [
      '| Operation | Round trips (pg / Drizzle / Prisma) | Raw pg p50 / p95 ms | Drizzle p50 / p95 ms | Prisma p50 / p95 ms | Completed rate/s (pg / Drizzle / Prisma) | Failures (pg / Drizzle / Prisma) |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...rows,
    ].join('\n') + '\n',
  );
}

async function main() {
  const adminUrlValue = process.env.DB_LANE_ADMIN_URL;
  if (adminUrlValue === undefined) {
    throw new Error(
      'Set DB_LANE_ADMIN_URL to the disposable local PostgreSQL admin URL',
    );
  }
  const adminUrl = assertDisposableAdminUrl(adminUrlValue);
  const databaseName = `aihub_bench_${process.pid}_${Date.now().toString(36)}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const adminPool = new Pool({ connectionString: adminUrlValue, max: 1 });
  let databaseCreated = false;
  let modes;
  let cleanupPool;

  try {
    const version = await adminPool.query(
      `SELECT current_setting('server_version') AS version,
              current_setting('server_version_num') AS version_num`,
    );
    if (!version.rows[0].version_num.startsWith('16')) {
      throw new Error(
        `Benchmark requires PostgreSQL 16; found ${version.rows[0].version}`,
      );
    }
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyMigrations(databaseUrl.toString());
    const counts = await seedDatabase(databaseUrl.toString());
    if (
      counts.apiKeys !== API_KEY_COUNT ||
      counts.usageRecords !== USAGE_RECORD_COUNT
    ) {
      throw new Error(`Seed count mismatch: ${JSON.stringify(counts)}`);
    }
    process.stdout.write(
      `Seeded PostgreSQL ${version.rows[0].version}: ${counts.apiKeys} API keys, ${counts.usageRecords} usage rows, and ${ORGANIZATION_COUNT} organizations\n`,
    );

    modes = makeModes(databaseUrl.toString());
    cleanupPool = new Pool({
      connectionString: databaseUrl.toString(),
      max: 1,
    });
    const from = new Date(Date.now() - 10 * 60 * 1_000);
    const to = new Date(Date.now() + 10 * 60 * 1_000);
    await verifyOutputs(modes, from, to, cleanupPool);
    process.stdout.write(
      'All three implementations returned equal fixture outputs before timing.\n',
    );

    const operations = [
      { name: 'apiKeyLookup', label: 'API-key lookup' },
      { name: 'meteringInsert', label: 'Durable Metering insert' },
      { name: 'lookupThenInsert', label: 'Lookup then insert' },
      { name: 'usageAggregate', label: 'Request/token aggregate', from, to },
    ];
    const results = new Map();
    const passOrders = [
      ['raw', 'drizzle', 'prisma'],
      ['prisma', 'drizzle', 'raw'],
    ];
    for (let passIndex = 0; passIndex < passOrders.length; passIndex += 1) {
      for (const modeName of passOrders[passIndex]) {
        const mode = modes[modeName];
        for (const operation of operations) {
          const result = await runPass(mode, operation, passIndex + 1);
          const key = `${modeName}:${operation.name}`;
          const passes = results.get(key) ?? [];
          passes.push(result);
          results.set(key, passes);
          process.stdout.write(
            `Completed ${modeName}/${operation.name} pass ${passIndex + 1}: ${result.completedRate.toFixed(1)}/s, ${result.roundTrips.toFixed(2)} trips/op\n`,
          );
        }
      }
    }
    renderResults(results, operations);
  } finally {
    await cleanupPool?.end();
    await modes?.close();
    if (databaseCreated) {
      await adminPool.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
    }
    await adminPool.end();
  }
}

await main();
