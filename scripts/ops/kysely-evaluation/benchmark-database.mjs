#!/usr/bin/env node
/**
 * #1018 PostgreSQL 16 comparison for the quota reconciliation read. Creates a
 * disposable database from the repository migrations, seeds representative
 * organizations and usage rows, then times the current Prisma raw path, raw
 * pg on the same shared pool shape, and the typed Kysely query.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** @typedef {import('./benchmark.d.mts').KyselyBenchmarkModule} KyselyBenchmarkModule */
/** @typedef {import('./benchmark.d.mts').PrismaBenchmarkModule} PrismaBenchmarkModule */
/** @typedef {import('./benchmark.d.mts').PgModule} PgModule */
/** @typedef {import('./benchmark.d.mts').PrismaAdapterModule} PrismaAdapterModule */
/** @typedef {import('./benchmark.d.mts').PrismaClientModule} PrismaClientModule */
/** @typedef {import('./benchmark.d.mts').PostgresPoolModule} PostgresPoolModule */
/** @typedef {import('./benchmark.d.mts').DatabaseBenchmarkRow} AggregateRow */
/** @typedef {import('./benchmark.d.mts').DatabaseQueryResult} AggregateResult */
/** @typedef {AggregateResult | readonly AggregateRow[]} QueryResult */
/** @typedef {{ version: string }} VersionRow */
/** @typedef {{ organization_id: string, quota: number | null, billable_count: string }} NormalizedRow */

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { Pool } = /** @type {PgModule} */ (require('pg'));
const { PrismaPg } = /** @type {PrismaAdapterModule} */ (
  require('@prisma/adapter-pg')
);
const { PrismaClient } = /** @type {PrismaClientModule} */ (
  require(join(root, 'dist/generated/prisma/client.js'))
);
const { createPostgresPool, postgresPoolOptions } =
  /** @type {PostgresPoolModule} */ (
    require(join(root, 'dist/common/postgres/postgres-pool.js'))
  );
const { compileKyselyQuotaReconciliation, createKyselyQuotaClient } =
  /** @type {KyselyBenchmarkModule} */ (
    require(
      join(
        root,
        'dist/modules/metering/infrastructure/billing/kysely-quota-reconciliation.js',
      ),
    )
  );
const { QUOTA_RECONCILIATION_SQL } = /** @type {PrismaBenchmarkModule} */ (
  require(
    join(
      root,
      'dist/modules/metering/infrastructure/billing/postgres-quota-reconciliation.repository.js',
    ),
  )
);

const ORGANIZATION_COUNT = 100;
const USAGE_RECORD_COUNT = 100_000;
const PASSES = 5;
const QUERIES_PER_PASS = 30;
const POOL_CONNECTIONS = 10;
const adminUrl = process.env.DB_LANE_ADMIN_URL;

/** @param {unknown} value @returns {string} */
function assertAdminUrl(value) {
  if (typeof value !== 'string') {
    throw new Error(
      'Set DB_LANE_ADMIN_URL to the disposable local PostgreSQL admin URL',
    );
  }
  const url = new URL(value);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '5433' ||
    url.pathname !== '/postgres'
  ) {
    throw new Error(
      'DB_LANE_ADMIN_URL must use localhost port 5433 and database postgres',
    );
  }
  return value;
}

/** @param {string} name */
function quoteIdentifier(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

/** @param {import('pg').Pool} pool @returns {Promise<number>} */
async function applyMigrations(pool) {
  const files = (
    await readdir(join(root, 'prisma/migrations'), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const filename of files) {
    await pool.query(
      await readFile(
        join(root, 'prisma/migrations', filename, 'migration.sql'),
        'utf8',
      ),
    );
  }
  return files.length;
}

/** @param {import('pg').Pool} pool @param {Date} from @param {Date} to @returns {Promise<string>} */
async function seed(pool, from, to) {
  await pool.query(`
    INSERT INTO organizations (id, name, monthly_request_quota)
    SELECT
      'bench_org_' || lpad(n::text, 3, '0'),
      'Kysely benchmark ' || n::text,
      (n + 1) * 100
    FROM generate_series(0, ${ORGANIZATION_COUNT - 1}) AS n
  `);
  await pool.query(
    `
      INSERT INTO usage_records (
        request_id, organization_id, api_key_id, service, operation,
        environment, outcome, http_status, billable_requests,
        metering_status, total_ms, created_at
      )
      SELECT
        'bench_usage_' || lpad(n::text, 7, '0'),
        'bench_org_' || lpad((n % ${ORGANIZATION_COUNT})::text, 3, '0'),
        'bench_key',
        'ai-speaking',
        'speaking.grade',
        'production',
        CASE WHEN n % 5 = 0 THEN 'downstream_error' ELSE 'success' END,
        CASE WHEN n % 5 = 0 THEN 502 ELSE 200 END,
        CASE WHEN n % 5 = 0 THEN 0 ELSE 1 END,
        'complete',
        10,
        $1::timestamptz + (n % 1000) * ($2::timestamptz - $1::timestamptz) / 1000
      FROM generate_series(1, ${USAGE_RECORD_COUNT}) AS n
    `,
    [from, to],
  );
  await pool.query('ANALYZE organizations; ANALYZE usage_records');
  const result =
    /** @type {import('pg').QueryResult<{ organizations: string }>} */ (
      await pool.query(
        'SELECT count(*)::text AS organizations FROM organizations',
      )
    );
  return result.rows[0]?.organizations ?? '0';
}

/** @param {QueryResult} result @returns {NormalizedRow[]} */
function normalize(result) {
  const rows = /** @type {readonly AggregateRow[]} */ (
    Array.isArray(result)
      ? result
      : /** @type {{ rows: readonly AggregateRow[] }} */ (result).rows
  );
  return rows.map((row) => ({
    organization_id: row.organization_id,
    quota: row.quota,
    billable_count: String(row.billable_count),
  }));
}

/** @param {number[]} values @param {number} fraction @returns {number} */
function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

/** @param {() => Promise<QueryResult>} operation @returns {Promise<number[]>} */
async function sample(operation) {
  const samples = [];
  for (let index = 0; index < QUERIES_PER_PASS; index += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

async function main() {
  const admin = assertAdminUrl(adminUrl);
  const databaseName = `aihub_kysely_${process.pid}_${Date.now().toString(36)}`;
  const databaseUrl = new URL(admin);
  databaseUrl.pathname = `/${databaseName}`;
  const adminPool = new Pool({ connectionString: admin, max: 1 });
  /** @type {import('pg').Pool | undefined} */
  let pool;
  /** @type {{ $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<readonly AggregateRow[]>, $disconnect: () => Promise<void> } | undefined} */
  let prisma;
  /** @type {ReturnType<KyselyBenchmarkModule['createKyselyQuotaClient']> | undefined} */
  let database;
  let created = false;

  try {
    const version = /** @type {import('pg').QueryResult<VersionRow>} */ (
      await adminPool.query(
        "SELECT current_setting('server_version') AS version",
      )
    );
    if (!version.rows[0].version.startsWith('16.')) {
      throw new Error(
        `PostgreSQL 16 required; found ${version.rows[0].version}`,
      );
    }
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;

    const url = databaseUrl.toString();
    const setupPool = new Pool({ connectionString: url, max: 1 });
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-10-01T00:00:00.000Z');
    let migrationCount;
    let organizationCount;
    try {
      migrationCount = await applyMigrations(setupPool);
      organizationCount = await seed(setupPool, from, to);
    } finally {
      await setupPool.end();
    }

    pool = createPostgresPool(
      'integration-test',
      postgresPoolOptions(url, POOL_CONNECTIONS),
    );
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    database = createKyselyQuotaClient(pool);

    /** @type {Record<string, () => Promise<QueryResult>>} */
    const modes = {
      prismaRaw: () =>
        /** @type {NonNullable<typeof prisma>} */ (prisma).$queryRawUnsafe(
          QUOTA_RECONCILIATION_SQL,
          from,
          to,
        ),
      rawPg: () =>
        /** @type {NonNullable<typeof pool>} */ (pool).query(
          QUOTA_RECONCILIATION_SQL,
          [from, to],
        ),
      kysely: () =>
        /** @type {NonNullable<typeof database>} */ (database).executeQuery(
          compileKyselyQuotaReconciliation(
            /** @type {NonNullable<typeof database>} */ (database),
            from,
            to,
          ),
        ),
    };

    const baseline = JSON.stringify(normalize(await modes.prismaRaw()));
    for (const [name, operation] of Object.entries(modes)) {
      if (JSON.stringify(normalize(await operation())) !== baseline) {
        throw new Error(`${name} returned different rows from Prisma raw SQL`);
      }
    }
    for (const operation of Object.values(modes)) await operation();

    /** @type {Record<string, number[]>} */
    const results = { prismaRaw: [], rawPg: [], kysely: [] };
    /** @type {Record<string, number[]>} */
    const allSamples = { prismaRaw: [], rawPg: [], kysely: [] };
    for (let pass = 0; pass < PASSES; pass += 1) {
      const order =
        pass % 2 === 0
          ? ['prismaRaw', 'rawPg', 'kysely']
          : ['kysely', 'rawPg', 'prismaRaw'];
      for (const name of order) {
        const samples = await sample(modes[name]);
        allSamples[name].push(...samples);
        results[name].push(percentile(samples, 0.5));
      }
    }

    process.stdout.write(
      [
        `Date: ${new Date().toISOString().slice(0, 10)}`,
        `Runtime: Node ${process.version} on ${process.platform} ${process.arch}`,
        `PostgreSQL: ${version.rows[0].version}; migrations: ${migrationCount}`,
        `Dataset: ${organizationCount} organizations, ${USAGE_RECORD_COUNT} usage rows, pool max ${POOL_CONNECTIONS}`,
        `Samples: ${PASSES} alternating passes of ${QUERIES_PER_PASS} queries per mode; all modes returned equal rows`,
        '',
        '| Mode | p50 (ms) | p95 (ms) | Pass p50 range (ms) |',
        '| --- | ---: | ---: | ---: |',
        ...Object.entries(allSamples).map(
          ([name, samples]) =>
            `| ${name} | ${percentile(samples, 0.5).toFixed(2)} | ${percentile(samples, 0.95).toFixed(2)} | ${Math.min(...results[name]).toFixed(2)}–${Math.max(...results[name]).toFixed(2)} |`,
        ),
        '',
      ].join('\n'),
    );
  } finally {
    // Kysely.destroy() closes the shared pg pool; calling pool.end() too fails.
    await database?.destroy();
    if (database === undefined) await pool?.end();
    await prisma?.$disconnect();
    if (created) {
      await adminPool.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
    }
    await adminPool.end();
  }
}

await main();
