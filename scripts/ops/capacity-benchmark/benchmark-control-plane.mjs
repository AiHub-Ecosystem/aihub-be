import { Buffer } from 'node:buffer';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
const prismaClientModule =
  /** @type {typeof import('../../../dist/generated/prisma/client.js')} */ (
    require('../../../dist/generated/prisma/client.js')
  );
const { PrismaClient } = prismaClientModule;

/** @typedef {{organization_id: string, api_key_id: string, organization_status: string, status: string, scopes: string[], entitlements: string[], allowed_environments: string[], expires_at: Date | null, rate_limit_rpm: number, max_concurrent: number, monthly_request_quota: number | null, hard_stop_on_quota: boolean}} RawApiKeyRow */
/** @typedef {{id: string, organizationId: string, status: string, scopes: string[], allowedEnvironments: string[], expiresAt: Date | null, organization: {status: string, entitlements: string[], rateLimitRpm: number, maxConcurrent: number, monthlyRequestQuota: number | null, hardStopOnQuota: boolean}}} PrismaApiKeyRow */
/** @typedef {RawApiKeyRow | PrismaApiKeyRow} ApiKeyLookupRow */
/** @typedef {{organizationId: string, apiKeyId: string, organizationStatus: string, status: string, scopes: string[], entitlements: string[], allowedEnvironments: string[], expiresAt: Date | null, rateLimitRpm: number, maxConcurrent: number, monthlyRequestQuota: number | null, hardStopOnQuota: boolean}} ApiKeyOutputInput */
/** @typedef {ApiKeyOutputInput} ApiKeyOutput */
/** @typedef {{billable_request_count: string | number | bigint, billable_token_count: string | number | bigint, missing_usage_count: string | number | bigint}} UsageAggregateRow */
/** @typedef {{request_id?: string, requestId?: string}} MeteringInsertRow */
/** @typedef {{requestId: string | null, organizationId: string, apiKeyId: string, actorId: null, service: string, operation: string, environment: string, outcome: string, httpStatus: number, errorCode: null, billableRequests: number, inputTokens: number, outputTokens: number, totalTokens: number, models: null, meteringStatus: string, totalMs: number, downstreamMs: number, aiProcessingMs: number}} UsageRecord */
/** @typedef {{reset: () => void, count: () => number}} PoolMetrics */
/** @typedef {(queryText: string, values?: Array<string | number | boolean | null | Date | Buffer>, callback?: import('pg').QueryResultCallback) => Promise<import('pg').QueryResult> | import('pg').Query} PgClientQuery */
/** @typedef {{metrics: PoolMetrics, name?: string, apiKeyLookup: () => Promise<ApiKeyLookupRow | null>, meteringInsert: (requestId: string) => Promise<MeteringInsertRow[]>, usageAggregate: (from: Date, to: Date) => Promise<UsageAggregateRow | undefined>, normalizeApiKey: (row: ApiKeyLookupRow | null) => ReturnType<typeof apiKeyOutput>, normalizeMeteringInsert: (rows: MeteringInsertRow[]) => Array<{requestId: string | undefined}>, normalizeUsageAggregate: (row: UsageAggregateRow | undefined) => ReturnType<typeof aggregateOutput>}} BenchmarkMode */
/** @typedef {Record<'raw' | 'prisma' | 'prismaRaw', BenchmarkMode>} BenchmarkModes */
/** @typedef {{name: string, label: string, from?: Date, to?: Date}} BenchmarkOperation */
/** @typedef {{p50: number | null, p95: number | null, completedRate: number, roundTrips: number | null, failures: number}} PassResult */
/** @typedef {{name: 'apiKeyLookup' | 'meteringInsert' | 'lookupThenInsert', label: string} | {name: 'usageAggregate', label: string, from: Date, to: Date}} BenchmarkOperation */
/** @typedef {'raw' | 'prisma' | 'prismaRaw'} BenchmarkModeName */
/** @typedef {Record<BenchmarkModeName, BenchmarkMode>} BenchmarkModeSet */
/** @typedef {{apiKeyLookup: ApiKeyOutput | null, meteringInsert: Array<{requestId: string | undefined}>, lookupThenInsert: {apiKey: ApiKeyOutput | null, inserted: Array<{requestId: string | undefined}>}, usageAggregate: ReturnType<typeof aggregateOutput>}} BenchmarkOutputs */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string[]} */
function isStringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/** @param {unknown} value @returns {RawApiKeyRow | null} */
function parseRawApiKeyRow(value) {
  if (value === null || value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.organization_id !== 'string' ||
    typeof value.api_key_id !== 'string' ||
    typeof value.organization_status !== 'string' ||
    typeof value.status !== 'string' ||
    !isStringArray(value.scopes) ||
    !isStringArray(value.entitlements) ||
    !isStringArray(value.allowed_environments) ||
    (value.expires_at !== null && !(value.expires_at instanceof Date)) ||
    typeof value.rate_limit_rpm !== 'number' ||
    typeof value.max_concurrent !== 'number' ||
    (value.monthly_request_quota !== null &&
      typeof value.monthly_request_quota !== 'number') ||
    typeof value.hard_stop_on_quota !== 'boolean'
  ) {
    throw new Error('API-key benchmark query returned an invalid row');
  }
  return {
    organization_id: value.organization_id,
    api_key_id: value.api_key_id,
    organization_status: value.organization_status,
    status: value.status,
    scopes: value.scopes,
    entitlements: value.entitlements,
    allowed_environments: value.allowed_environments,
    expires_at: value.expires_at,
    rate_limit_rpm: value.rate_limit_rpm,
    max_concurrent: value.max_concurrent,
    monthly_request_quota: value.monthly_request_quota,
    hard_stop_on_quota: value.hard_stop_on_quota,
  };
}

/** @param {unknown} value @returns {MeteringInsertRow[]} */
function parseMeteringInsertRows(value) {
  if (!Array.isArray(value))
    throw new Error('Metering benchmark query returned invalid rows');
  return value.map((row) => {
    if (
      !isRecord(row) ||
      (typeof row.request_id !== 'string' && typeof row.requestId !== 'string')
    ) {
      throw new Error('Metering benchmark query returned an invalid row');
    }
    return {
      ...(typeof row.request_id === 'string'
        ? { request_id: row.request_id }
        : {}),
      ...(typeof row.requestId === 'string'
        ? { requestId: row.requestId }
        : {}),
    };
  });
}

/** @param {unknown} value @returns {UsageAggregateRow | undefined} */
function parseUsageAggregateRow(value) {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !['string', 'number', 'bigint'].includes(
      typeof value.billable_request_count,
    ) ||
    !['string', 'number', 'bigint'].includes(
      typeof value.billable_token_count,
    ) ||
    !['string', 'number', 'bigint'].includes(typeof value.missing_usage_count)
  ) {
    throw new Error('usage aggregate benchmark query returned an invalid row');
  }
  return {
    billable_request_count: sqlCount(value.billable_request_count),
    billable_token_count: sqlCount(value.billable_token_count),
    missing_usage_count: sqlCount(value.missing_usage_count),
  };
}

/** @param {unknown} value @returns {value is string | number | bigint} */
function isSqlCount(value) {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  );
}

/** @param {unknown} value @returns {string | number | bigint} */
function sqlCount(value) {
  if (!isSqlCount(value)) throw new Error('invalid SQL aggregate count');
  return value;
}

/** @param {unknown} value @returns {unknown} */
function firstArrayItem(value) {
  if (!Array.isArray(value))
    throw new Error('benchmark query returned invalid rows');
  return value[0];
}

/** @param {unknown} value @returns {{version: string, version_num: string}} */
function parseVersion(value) {
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    typeof value.version_num !== 'string'
  ) {
    throw new Error('PostgreSQL version query returned an invalid row');
  }
  return { version: value.version, version_num: value.version_num };
}

/** @param {unknown} value @returns {{apiKeys: number, usageRecords: number}} */
function parseSeedCounts(value) {
  if (
    !isRecord(value) ||
    (typeof value.api_keys !== 'string' &&
      typeof value.api_keys !== 'number') ||
    (typeof value.usage_records !== 'string' &&
      typeof value.usage_records !== 'number')
  ) {
    throw new Error('Benchmark seed count query returned an invalid row');
  }
  return {
    apiKeys: Number(value.api_keys),
    usageRecords: Number(value.usage_records),
  };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
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

/** @param {string} connectionString */
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

/** @param {string} identifier */
function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** @param {import('pg').Pool} pool @returns {PoolMetrics} */
function instrumentPool(pool) {
  let statements = 0;
  const wrapped = new WeakSet();
  pool.on(
    'acquire',
    /** @param {import('pg').PoolClient} client */ (client) => {
      if (wrapped.has(client)) {
        return;
      }
      wrapped.add(client);
      /** @type {PgClientQuery} */
      const query = client.query.bind(client);
      /** @type {PgClientQuery} */
      client.query = (queryText, values, callback) => {
        statements += 1;
        if (callback !== undefined) return query(queryText, values, callback);
        return values === undefined
          ? query(queryText)
          : query(queryText, values);
      };
    },
  );
  return {
    reset: () => {
      statements = 0;
    },
    count: () => statements,
  };
}

/** @param {ApiKeyOutputInput | null | undefined} row */
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

/** @param {RawApiKeyRow | null | undefined} row */
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

/** @param {ApiKeyLookupRow | null} row */
function normalizeApiKey(row) {
  if (row === null) return null;
  return 'organization_id' in row
    ? rawApiKeyOutput(row)
    : prismaApiKeyOutput(row);
}

/** @param {PrismaApiKeyRow | null | undefined} row */
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

/** @param {MeteringInsertRow[]} rows */
function meteringInsertOutput(rows) {
  return rows.map((row) => ({
    requestId: row.request_id ?? row.requestId,
  }));
}

/** @param {string} requestId @returns {UsageRecord} */
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

/** @param {UsageRecord} record @returns {Array<string | number | null>} */
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

/** @param {UsageAggregateRow | undefined} row */
function aggregateOutput(row) {
  if (row === undefined) throw new Error('usage aggregate returned no row');
  return {
    billableRequestCount: String(row.billable_request_count),
    billableTokenCount: String(row.billable_token_count),
    missingUsageCount: String(row.missing_usage_count),
  };
}

/** @param {unknown} value */
function canonical(value) {
  return JSON.stringify(value);
}

/** @param {string | URL} databaseUrl */
async function applyMigrations(databaseUrl) {
  const migrationsDirectory = join(ROOT, 'prisma/migrations');
  const files = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    for (const filename of files) {
      await pool.query(
        await readFile(
          join(migrationsDirectory, filename, 'migration.sql'),
          'utf8',
        ),
      );
    }
  } finally {
    await pool.end();
  }
}

/** @param {string} databaseUrl */
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
    /** @type {import('pg').QueryResult<{api_keys: string, usage_records: string}>} */
    const counts = await pool.query(`
      SELECT
        (SELECT count(*) FROM api_keys) AS api_keys,
        (SELECT count(*) FROM usage_records) AS usage_records
    `);
    return parseSeedCounts(counts.rows[0]);
  } finally {
    await pool.end();
  }
}

/** @param {string} databaseUrl @returns {BenchmarkModeSet & {close: () => Promise<void>}} */
function makeModes(databaseUrl) {
  const rawPool = new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
  const rawMetrics = instrumentPool(rawPool);

  const prismaPool = new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
  const prismaMetrics = instrumentPool(prismaPool);
  const prismaClient = new PrismaClient({ adapter: new PrismaPg(prismaPool) });

  /** @type {BenchmarkMode} */
  const raw = {
    metrics: rawMetrics,
    normalizeApiKey,
    normalizeMeteringInsert: meteringInsertOutput,
    normalizeUsageAggregate: aggregateOutput,
    async apiKeyLookup() {
      const result = await rawPool.query(API_KEY_LOOKUP_SQL, [LOOKUP_HASH]);
      return parseRawApiKeyRow(result.rows[0] ?? null);
    },
    async meteringInsert(requestId) {
      const result = await rawPool.query(
        METERING_INSERT_SQL,
        usageRecordValues(usageRecord(requestId)),
      );
      return parseMeteringInsertRows(result.rows);
    },
    async usageAggregate(from, to) {
      const result = await rawPool.query(USAGE_AGGREGATE_SQL, [
        ORGANIZATION_ID,
        from,
        to,
        null,
      ]);
      return parseUsageAggregateRow(result.rows[0]);
    },
  };

  /** @type {BenchmarkMode} */
  const prisma = {
    metrics: prismaMetrics,
    normalizeApiKey,
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
      return parseUsageAggregateRow(firstArrayItem(rows));
    },
  };

  // The exact SQL of the raw mode, issued through Prisma's raw path on the same
  // adapter pool: what the production repositories do where the generated
  // client cannot express the statement or where one statement is the contract.
  /** @type {BenchmarkMode} */
  const prismaRaw = {
    metrics: prismaMetrics,
    normalizeApiKey,
    normalizeMeteringInsert: meteringInsertOutput,
    normalizeUsageAggregate: aggregateOutput,
    async apiKeyLookup() {
      const rows = await prismaClient.$queryRawUnsafe(
        API_KEY_LOOKUP_SQL,
        LOOKUP_HASH,
      );
      return parseRawApiKeyRow(firstArrayItem(rows));
    },
    async meteringInsert(requestId) {
      const rows = await prismaClient.$queryRawUnsafe(
        METERING_INSERT_SQL,
        ...usageRecordValues(usageRecord(requestId)),
      );
      return parseMeteringInsertRows(rows);
    },
    async usageAggregate(from, to) {
      const rows = await prismaClient.$queryRawUnsafe(
        USAGE_AGGREGATE_SQL,
        ORGANIZATION_ID,
        from,
        to,
        null,
      );
      return parseUsageAggregateRow(firstArrayItem(rows));
    },
  };

  for (const [modeName, mode] of Object.entries({
    raw,
    prisma,
    prismaRaw,
  })) {
    mode.apiKeyLookup = mode.apiKeyLookup.bind(mode);
    mode.meteringInsert = mode.meteringInsert.bind(mode);
    mode.usageAggregate = mode.usageAggregate.bind(mode);
    mode.name = modeName;
  }

  return {
    raw,
    prisma,
    prismaRaw,
    async close() {
      await prismaClient.$disconnect();
      await Promise.all([rawPool.end(), prismaPool.end()]);
    },
  };
}

/** @type {BenchmarkModeName[]} */
const MODE_NAMES = ['raw', 'prisma', 'prismaRaw'];
/** @type {Record<BenchmarkModeName, string>} */
const MODE_LABELS = {
  raw: 'Raw pg',
  prisma: 'Prisma client',
  prismaRaw: 'Prisma raw SQL',
};

/** @param {BenchmarkModeSet} modes @param {Date} from @param {Date} to @param {import('pg').Pool} cleanupPool */
async function verifyOutputs(modes, from, to, cleanupPool) {
  /** @type {Map<BenchmarkModeName, BenchmarkOutputs>} */
  const operationResults = new Map();
  const fixtureRequestId = 'bench_verify_523';

  for (const modeName of MODE_NAMES) {
    const mode = modes[modeName];
    const rawApiKey = await mode.apiKeyLookup();
    /** @type {BenchmarkOutputs} */
    const outputs = {
      apiKeyLookup: mode.normalizeApiKey(rawApiKey),
      meteringInsert: [],
      lookupThenInsert: { apiKey: null, inserted: [] },
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

/** @param {number[]} samples @param {number} fraction @returns {number} */
function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

/** @param {BenchmarkMode} mode @param {BenchmarkOperation} operation @param {number} passNumber @returns {Promise<PassResult>} */
async function runPass(mode, operation, passNumber) {
  mode.metrics.reset();
  /** @type {number[]} */
  const samples = [];
  let failures = 0;
  /** @type {Promise<void>[]} */
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

/** @param {Array<number | null>} values @returns {string} */
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

/** @param {Map<string, PassResult[]>} results @param {BenchmarkOperation[]} operations */
function renderResults(results, operations) {
  /** @param {BenchmarkOperation} operation @param {'roundTrips' | 'completedRate' | 'failures'} field */
  const column = (operation, field) =>
    MODE_NAMES.map((modeName) =>
      range(
        results.get(`${modeName}:${operation.name}`).map((pass) => pass[field]),
      ),
    ).join(' / ');
  /** @param {BenchmarkOperation} operation @param {BenchmarkModeName} modeName */
  const latency = (operation, modeName) => {
    const passes = results.get(`${modeName}:${operation.name}`);
    return `${range(passes.map((pass) => pass.p50))} / ${range(
      passes.map((pass) => pass.p95),
    )}`;
  };
  const rows = operations.map(
    (operation) =>
      `| ${operation.label} | ${column(operation, 'roundTrips')} | ${MODE_NAMES.map(
        (modeName) => latency(operation, modeName),
      ).join(
        ' | ',
      )} | ${column(operation, 'completedRate')} | ${column(operation, 'failures')} |`,
  );
  const labels = MODE_NAMES.map((modeName) => MODE_LABELS[modeName]);
  process.stdout.write(
    [
      `| Operation | Round trips (${labels.join(' / ')}) | ${labels
        .map((label) => `${label} p50 / p95 ms`)
        .join(' | ')} | Completed rate/s | Failures |`,
      `| --- | ---: | ${labels.map(() => '---: |').join(' ')} ---: | ---: |`,
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
  /** @type {(BenchmarkModeSet & {close: () => Promise<void>}) | undefined} */
  let modes;
  /** @type {import('pg').Pool | undefined} */
  let cleanupPool;

  try {
    const version = await adminPool.query(
      `SELECT current_setting('server_version') AS version,
              current_setting('server_version_num') AS version_num`,
    );
    const serverVersion = parseVersion(version.rows[0]);
    if (!serverVersion.version_num.startsWith('16')) {
      throw new Error(
        `Benchmark requires PostgreSQL 16; found ${serverVersion.version}`,
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
      `Seeded PostgreSQL ${serverVersion.version}: ${counts.apiKeys} API keys, ${counts.usageRecords} usage rows, and ${ORGANIZATION_COUNT} organizations\n`,
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
      'Every implementation returned equal fixture outputs before timing.\n',
    );

    /** @type {BenchmarkOperation[]} */
    const operations = [
      { name: 'apiKeyLookup', label: 'API-key lookup' },
      { name: 'meteringInsert', label: 'Durable Metering insert' },
      { name: 'lookupThenInsert', label: 'Lookup then insert' },
      { name: 'usageAggregate', label: 'Request/token aggregate', from, to },
    ];
    /** @type {Map<string, PassResult[]>} */
    const results = new Map();
    // Forward, then reversed, so no mode always runs on a warmer database.
    const passOrders = [MODE_NAMES, [...MODE_NAMES].reverse()];
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
