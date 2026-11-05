#!/usr/bin/env node
/**
 * #1018 spike. Compares query construction and row delivery for the quota
 * reconciliation read on a stub pg pool, so the benchmark needs no database.
 * Prisma raw SQL keeps the production statement text; Kysely builds an
 * equivalent typed statement and executes it through the same pool shape.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

/** @typedef {import('./benchmark.d.mts').KyselyBenchmarkModule} KyselyBenchmarkModule */
/** @typedef {import('./benchmark.d.mts').PrismaBenchmarkModule} PrismaBenchmarkModule */
/** @typedef {import('./benchmark.d.mts').BenchmarkRow} BenchmarkRow */
/** @typedef {import('./benchmark.d.mts').StubPool} StubPool */

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { QUOTA_RECONCILIATION_SQL } = /** @type {PrismaBenchmarkModule} */ (
  require(
    join(
      root,
      'dist/modules/metering/infrastructure/billing/postgres-quota-reconciliation.repository.js',
    ),
  )
);

/** @returns {KyselyBenchmarkModule} */
function loadKyselyBenchmarkModule() {
  return /** @type {KyselyBenchmarkModule} */ (
    require(
      join(
        root,
        'dist/modules/metering/infrastructure/billing/kysely-quota-reconciliation.js',
      ),
    )
  );
}

const ORGANIZATION_COUNT = 100;
const QUERY_COUNT = 5_000;
const PASSES = 5;
const TYPE_CHECK_SAMPLES = 5;
const from = new Date('2026-09-01T00:00:00.000Z');
const to = new Date('2026-10-01T00:00:00.000Z');
const rows = /** @type {BenchmarkRow[]} */ (
  Array.from({ length: ORGANIZATION_COUNT }, (_, index) => ({
    organization_id: `org_${String(index).padStart(3, '0')}`,
    quota: (index + 1) * 10,
    billable_count: BigInt(index * 3),
  }))
);

/** @param {(text: string, values: readonly unknown[]) => void} record */
function stubPool(record) {
  return /** @type {StubPool} */ ({
    connect: () =>
      Promise.resolve({
        getTransactionStatus: () => 'I',
        query: () =>
          Promise.resolve({ rows, command: 'SELECT', rowCount: rows.length }),
        release: () => {},
      }),
    query: (text, values) => {
      record(text, values);
      return Promise.resolve({
        rows,
        command: 'SELECT',
        rowCount: rows.length,
      });
    },
    end: () => Promise.resolve(),
    on: () => {},
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  });
}

/** @param {number[]} values @param {number} fraction @returns {number} */
function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

/** @param {() => Promise<unknown>} operation @returns {Promise<number[]>} */
async function sample(operation) {
  const samples = [];
  for (let index = 0; index < QUERY_COUNT; index += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

/** @param {number[]} values @returns {string} */
function summarize(values) {
  return `${percentile(values, 0.5).toFixed(4)} / ${percentile(values, 0.95).toFixed(4)}`;
}

/** @param {string} label @param {string[]} args */
function typeCheckSample(label, args) {
  const times = [];
  for (let index = 0; index < TYPE_CHECK_SAMPLES; index += 1) {
    const startedAt = performance.now();
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/typescript/bin/tsc6'),
        '--noEmit',
        '--incremental',
        'false',
        ...args,
      ],
      { cwd: root, stdio: 'pipe', encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(
        `${label} type-check failed: ${result.stderr || result.stdout}`,
      );
    }
    times.push((performance.now() - startedAt) / 1_000);
  }
  return times;
}

async function main() {
  const { compileKyselyQuotaReconciliation, createKyselyQuotaClient } =
    loadKyselyBenchmarkModule();
  let statements = 0;
  const pool = stubPool(() => {
    statements += 1;
  });
  const database = createKyselyQuotaClient(pool);
  const prismaRaw = async () =>
    pool.query(QUOTA_RECONCILIATION_SQL, [from, to]);
  const kysely = async () => {
    const compiled = compileKyselyQuotaReconciliation(database, from, to);
    return database.executeQuery(compiled);
  };

  const baselineRows = await prismaRaw();
  const kyselyRows = await kysely();
  /** @param {unknown} key @param {unknown} value @returns {unknown} */
  const normalizeBigInt = (key, value) =>
    typeof value === 'bigint' ? value.toString() : value;
  if (
    JSON.stringify(baselineRows.rows, normalizeBigInt) !==
    JSON.stringify(kyselyRows.rows, normalizeBigInt)
  ) {
    throw new Error('Kysely and Prisma raw SQL returned different rows');
  }

  /** @type {Record<string, number[]>} */
  const results = { prismaRaw: [], kysely: [] };
  for (let pass = 0; pass < PASSES; pass += 1) {
    const order =
      pass % 2 === 0 ? ['prismaRaw', 'kysely'] : ['kysely', 'prismaRaw'];
    for (const name of order) {
      const operation = name === 'prismaRaw' ? prismaRaw : kysely;
      const samples = await sample(operation);
      results[name].push(percentile(samples, 0.5));
    }
  }

  /** @type {Record<string, number>} */
  const rss = {};
  for (const mode of ['prismaRaw', 'kysely', 'kyselyImport']) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--rss', mode],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    rss[mode] = Number(result.stdout.trim());
  }

  const withKysely = typeCheckSample('with Kysely', [
    '--project',
    'tsconfig.json',
  ]);
  const withoutKysely = typeCheckSample('without Kysely', [
    '--project',
    'scripts/ops/kysely-evaluation/tsconfig.baseline.json',
  ]);
  const focused = typeCheckSample('focused generated DB types', [
    '--project',
    'scripts/ops/kysely-evaluation/tsconfig.kysely-types.json',
  ]);
  const focusedBaseline = typeCheckSample('focused empty types', [
    '--project',
    'scripts/ops/kysely-evaluation/tsconfig.empty-types.json',
  ]);

  process.stdout.write(
    [
      `Date: ${new Date().toISOString().slice(0, 10)}`,
      `Runtime: Node ${process.version} on ${process.platform} ${process.arch}`,
      `Dataset: ${ORGANIZATION_COUNT} rows returned per query, ${QUERY_COUNT} queries per pass, ${PASSES} alternating passes`,
      `Rows: equal across both modes; statements executed: ${statements}`,
      '',
      '| Mode | Query p50 / p95 (ms) | p50 across passes (ms) | Peak RSS (MiB) |',
      '| --- | ---: | ---: | ---: |',
      `| Prisma raw SQL | ${summarize(await sample(prismaRaw))} | ${Math.min(...results.prismaRaw).toFixed(4)}–${Math.max(...results.prismaRaw).toFixed(4)} | ${(rss.prismaRaw / 1024 / 1024).toFixed(1)} |`,
      `| Kysely | ${summarize(await sample(kysely))} | ${Math.min(...results.kysely).toFixed(4)}–${Math.max(...results.kysely).toFixed(4)} | ${(rss.kysely / 1024 / 1024).toFixed(1)} |`,
      `| Kysely import only | n/a | n/a | ${(rss.kyselyImport / 1024 / 1024).toFixed(1)} |`,
      '',
      '| Type-check scope | Median (s) | Samples (s) |',
      '| --- | ---: | ---: |',
      `| Whole project with Kysely | ${percentile(withKysely, 0.5).toFixed(2)} | ${withKysely.map((value) => value.toFixed(2)).join(', ')} |`,
      `| Whole project without Kysely spike files | ${percentile(withoutKysely, 0.5).toFixed(2)} | ${withoutKysely.map((value) => value.toFixed(2)).join(', ')} |`,
      '',
      '| Focused type-check | Median (ms) | Samples (ms) |',
      '| --- | ---: | ---: |',
      `| Generated Kysely DB types | ${(percentile(focused, 0.5) * 1_000).toFixed(0)} | ${focused.map((value) => (value * 1_000).toFixed(0)).join(', ')} |`,
      `| Empty type-check baseline | ${(percentile(focusedBaseline, 0.5) * 1_000).toFixed(0)} | ${focusedBaseline.map((value) => (value * 1_000).toFixed(0)).join(', ')} |`,
      '',
    ].join('\n'),
  );
  await database.destroy();
}

async function rssProbe(mode) {
  let peakRss = process.memoryUsage.rss();
  const sampleRss = () => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  };
  if (mode === 'prismaRaw') {
    const pool = stubPool(() => {});
    for (let index = 0; index < QUERY_COUNT; index += 1) {
      await pool.query(QUOTA_RECONCILIATION_SQL, [from, to]);
      if (index % 100 === 0) sampleRss();
    }
    sampleRss();
    process.stdout.write(String(peakRss));
    return;
  }
  const { compileKyselyQuotaReconciliation, createKyselyQuotaClient } =
    loadKyselyBenchmarkModule();
  if (mode === 'kyselyImport') {
    const pool = stubPool(() => {});
    await createKyselyQuotaClient(pool).destroy();
    sampleRss();
    process.stdout.write(String(peakRss));
    return;
  }
  const pool = stubPool(() => {});
  const database = createKyselyQuotaClient(pool);
  const operation = () =>
    database.executeQuery(compileKyselyQuotaReconciliation(database, from, to));
  for (let index = 0; index < QUERY_COUNT; index += 1) {
    await operation();
    if (index % 100 === 0) sampleRss();
  }
  sampleRss();
  process.stdout.write(String(peakRss));
  await database.destroy();
}

if (process.argv.includes('--rss')) {
  const mode = process.argv[process.argv.indexOf('--rss') + 1];
  await rssProbe(mode);
  if (process.argv.includes('--assert-no-kysely')) {
    const loaded = require.cache;
    const hasKysely = Object.keys(loaded).some((path) =>
      path.split(/[\\/]/).includes('kysely'),
    );
    if (hasKysely) {
      throw new Error(`${mode} RSS process loaded a Kysely module`);
    }
    process.stderr.write('no Kysely modules loaded\n');
  }
} else {
  await main();
}
