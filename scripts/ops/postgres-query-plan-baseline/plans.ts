import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient } from 'pg';
import { format } from 'prettier';

import { BASELINE } from './config';
import { baselineQueries } from './query-set';
import type { BaselineQuery, PlanDocument, PlanNode, TableSize } from './types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function walkPlan(node: PlanNode, depth = 0): readonly string[] {
  const details = [node['Node Type'] ?? 'Unknown node'];
  if (node['Relation Name'] !== undefined) details.push(node['Relation Name']);
  if (node['Index Name'] !== undefined)
    details.push(`using ${node['Index Name']}`);
  if (node['Actual Rows'] !== undefined) {
    details.push(
      `actual rows=${node['Actual Rows']} loops=${node['Actual Loops'] ?? 1}`,
    );
  }
  if (node['Actual Total Time'] !== undefined) {
    details.push(`time=${node['Actual Total Time'].toFixed(3)} ms`);
  }
  if (node['Rows Removed by Filter'] !== undefined) {
    details.push(`filtered=${node['Rows Removed by Filter']}`);
  }
  if (node['Heap Fetches'] !== undefined) {
    details.push(`heap fetches=${node['Heap Fetches']}`);
  }
  if (node['Index Cond'] !== undefined) {
    details.push(`index condition=${node['Index Cond']}`);
  }
  if (node.Filter !== undefined) details.push(`filter=${node.Filter}`);
  if (node.Output !== undefined) {
    details.push(`output=${node.Output.join(', ')}`);
  }
  const hit = node['Shared Hit Blocks'] ?? 0;
  const read = node['Shared Read Blocks'] ?? 0;
  if (hit + read > 0) details.push(`shared buffers hit/read=${hit}/${read}`);
  const tempRead = node['Temp Read Blocks'] ?? 0;
  const tempWritten = node['Temp Written Blocks'] ?? 0;
  if (tempRead + tempWritten > 0) {
    details.push(`temp blocks read/written=${tempRead}/${tempWritten}`);
  }
  if (node['Sort Method'] !== undefined) {
    details.push(
      `sort=${node['Sort Method']} ${node['Sort Space Used'] ?? 0} ${node['Sort Space Type'] ?? ''}`.trim(),
    );
  }
  if (node['Conflict Arbiter Indexes'] !== undefined) {
    details.push(
      `conflict arbiter=${node['Conflict Arbiter Indexes'].join(', ')}`,
    );
  }
  const line = `${'  '.repeat(depth)}- ${details.join('; ')}`;
  return [
    line,
    ...(node.Plans ?? []).flatMap((child) => walkPlan(child, depth + 1)),
  ];
}

function sequentialScans(node: PlanNode): readonly string[] {
  const ownScan =
    node['Node Type']?.includes('Seq Scan') === true &&
    node['Relation Name'] !== undefined
      ? [`${node['Relation Name']} (${node['Actual Rows'] ?? 0} rows)`]
      : [];
  return [...ownScan, ...(node.Plans ?? []).flatMap(sequentialScans)];
}

function sequentialScanTables(node: PlanNode): readonly string[] {
  return [
    ...(node['Node Type']?.includes('Seq Scan') === true &&
    node['Relation Name'] !== undefined
      ? [node['Relation Name']]
      : []),
    ...(node.Plans ?? []).flatMap(sequentialScanTables),
  ];
}

function indexNames(node: PlanNode): readonly string[] {
  return [
    ...(node['Index Name'] === undefined ? [] : [node['Index Name']]),
    ...(node['Conflict Arbiter Indexes'] ?? []),
    ...(node.Plans ?? []).flatMap(indexNames),
  ];
}

function findPlanNode(
  node: PlanNode,
  predicate: (candidate: PlanNode) => boolean,
): PlanNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.Plans ?? []) {
    const found = findPlanNode(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function explain(
  client: PoolClient,
  query: BaselineQuery,
): Promise<PlanDocument> {
  let inTransaction = false;
  try {
    if (query.mutates === true) {
      await client.query('BEGIN');
      inTransaction = true;
    }
    const result = await client.query<{ readonly 'QUERY PLAN': unknown }>(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${query.sql}`,
      [...query.parameters],
    );
    const value = result.rows[0]?.['QUERY PLAN'];
    if (
      !Array.isArray(value) ||
      typeof value[0] !== 'object' ||
      value[0] === null
    ) {
      throw new Error(`PostgreSQL returned no plan for ${query.name}`);
    }
    const plan = value[0] as PlanDocument;
    if (inTransaction) {
      await client.query('ROLLBACK');
      inTransaction = false;
    }
    return plan;
  } finally {
    if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
  }
}

function prettyBytes(value: string): string {
  let bytes = Number(value);
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit += 1;
  }
  return `${bytes.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function tableSizes(pool: Pool): Promise<ReadonlyMap<string, TableSize>> {
  const names = [
    'organizations',
    'api_keys',
    'user_accounts',
    'organization_members',
    'idempotency_records',
    'sandbox_allowance_defaults',
    'sandbox_allowance_overrides',
    'sandbox_dispatch_reservations',
    'usage_records',
    'dispatch_attempts',
  ];
  const sizes = new Map<string, TableSize>();
  for (const name of names) {
    const result = await pool.query<{
      readonly rows: string;
      readonly tableBytes: string;
      readonly indexBytes: string;
      readonly totalBytes: string;
      readonly createdAtCorrelation: string;
    }>(
      `SELECT count(*)::text AS rows,
              pg_table_size($1::regclass)::text AS "tableBytes",
              pg_indexes_size($1::regclass)::text AS "indexBytes",
              pg_total_relation_size($1::regclass)::text AS "totalBytes",
              COALESCE((
                SELECT correlation::text
                FROM pg_stats
                WHERE schemaname = current_schema()
                  AND tablename = $1::text
                  AND attname = 'created_at'
              ), 'n/a') AS "createdAtCorrelation"
       FROM ${quoteIdentifier(name)}`,
      [name],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Missing size data for ${name}`);
    sizes.set(name, {
      rows: row.rows,
      tableBytes: prettyBytes(row.tableBytes),
      indexBytes: prettyBytes(row.indexBytes),
      totalBytes: prettyBytes(row.totalBytes),
      createdAtCorrelation: row.createdAtCorrelation,
    });
  }
  return sizes;
}

function renderReport(
  version: string,
  plans: readonly {
    readonly query: BaselineQuery;
    readonly plan: PlanDocument;
  }[],
  sizes: ReadonlyMap<string, TableSize>,
  statsEnabled: boolean,
): string {
  const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const dirty =
    execFileSync('git', ['status', '--porcelain'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim().length > 0;
  const generatedAt = new Date().toISOString();
  const lines = [
    '# PostgreSQL query-plan and growth baseline',
    '',
    `Generated: ${generatedAt}`,
    `Source revision: ${revision}${dirty ? ' (working tree had local changes)' : ''}`,
    `Database: local disposable PostgreSQL ${version}; this is synthetic data, not a production rate limit.`,
    `Seed: ${BASELINE.organizationCount} Organizations, ${BASELINE.apiKeyCount.toLocaleString()} API keys, ${BASELINE.membershipCount.toLocaleString()} memberships, ${BASELINE.usageRecordCount.toLocaleString()} usage records, ${BASELINE.idempotencyRecordCount.toLocaleString()} idempotency records, ${BASELINE.dispatchAttemptCount.toLocaleString()} dispatch attempts, and ${BASELINE.sandboxReservationCount.toLocaleString()} Sandbox reservations.`,
    `Retention cutoff: ${BASELINE.retentionDays} days; timestamps span ${BASELINE.retentionSpanSeconds / 86400} days; batch size: ${BASELINE.retentionBatchSize}.`,
    `pg_stat_statements: ${statsEnabled ? 'installed in this disposable database; per-statement statistics were not reset.' : 'not installed in this disposable database.'}`,
    '',
    '## Relation sizes',
    '',
    '| Table | Rows | Heap/table | Indexes | Total | created_at correlation |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const [name, size] of sizes) {
    lines.push(
      `| \`${name}\` | ${Number(size.rows).toLocaleString()} | ${size.tableBytes} | ${size.indexBytes} | ${size.totalBytes} | ${size.createdAtCorrelation === 'n/a' ? '—' : Number(size.createdAtCorrelation).toFixed(3)} |`,
    );
  }
  const usageRetention = plans.find(
    ({ query }) => query.name === 'Usage-record retention batch',
  );
  const usageSize = sizes.get('usage_records');
  const usageHeapScan = usageRetention
    ? findPlanNode(
        usageRetention.plan.Plan,
        (node) =>
          node['Relation Name'] === 'usage_records' &&
          node['Node Type']?.includes('Heap Scan') === true,
      )
    : undefined;
  const usageSort = usageRetention
    ? findPlanNode(
        usageRetention.plan.Plan,
        (node) => node['Node Type'] === 'Sort',
      )
    : undefined;
  const usageSortSummary =
    usageSort === undefined
      ? 'was not reported'
      : usageSort['Sort Space Type'] === 'Disk'
        ? `${usageSort['Sort Method'] ?? 'Sort'} sort spilled ${usageSort['Sort Space Used']?.toLocaleString() ?? 'an unreported amount'} KiB to disk`
        : `${usageSort['Sort Method'] ?? 'Sort'} sort used ${usageSort['Sort Space Used']?.toLocaleString() ?? 'an unreported amount'} ${usageSort['Sort Space Type'] ?? 'space'}`;
  const dispatchRetention = plans.find(
    ({ query }) => query.name === 'Dispatch-attempt retention batch',
  );
  const indexOnlyScanObserved = plans.some(
    ({ plan }) =>
      findPlanNode(
        plan.Plan,
        (node) => node['Node Type'] === 'Index Only Scan',
      ) !== undefined,
  );
  lines.push(
    '',
    '## Plans',
    '',
    'Each plan is `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` from PostgreSQL 16. Verbose node outputs expose projected columns; index conditions and heap fetches make column and covering-index reviews possible. Mutating retention and idempotency statements ran in transactions that were rolled back. The statement shape comes from the repository SQL constants where available; Sandbox ORM reads are represented by their mapped SQL predicates.',
    '',
  );
  for (const { query, plan } of plans) {
    const names = [...new Set(indexNames(plan.Plan))];
    const foundExpected = query.expectedIndexes.filter((name) =>
      names.includes(name),
    );
    const missingExpected = query.expectedIndexes.filter(
      (name) => !names.includes(name),
    );
    const seqScans = sequentialScans(plan.Plan);
    const observedSeqScanTables = new Set(sequentialScanTables(plan.Plan));
    const expectedSeqScanTables = query.expectedSeqScanTables ?? [];
    const foundExpectedSeqScans = expectedSeqScanTables.filter((name) =>
      observedSeqScanTables.has(name),
    );
    const missingExpectedSeqScans = expectedSeqScanTables.filter(
      (name) => !observedSeqScanTables.has(name),
    );
    const tableList = query.tables
      .map((name) => {
        const size = sizes.get(name);
        return size === undefined
          ? `\`${name}\``
          : `\`${name}\` ${Number(size.rows).toLocaleString()} rows/${size.totalBytes}`;
      })
      .join(', ');
    lines.push(
      `### ${query.name}`,
      '',
      `Tables: ${tableList}.`,
      `Planning: ${plan['Planning Time'].toFixed(3)} ms; execution: ${plan['Execution Time'].toFixed(3)} ms.`,
      `Indexes observed: ${names.length === 0 ? 'none' : names.map((name) => `\`${name}\``).join(', ')}.`,
      `Expected indexes observed: ${foundExpected.length === 0 ? 'none' : foundExpected.map((name) => `\`${name}\``).join(', ')}. Missing: ${missingExpected.length === 0 ? 'none' : missingExpected.map((name) => `\`${name}\``).join(', ')}.`,
      `Expected sequential scans observed: ${foundExpectedSeqScans.length === 0 ? 'none' : foundExpectedSeqScans.map((name) => `\`${name}\``).join(', ')}. Missing: ${missingExpectedSeqScans.length === 0 ? 'none' : missingExpectedSeqScans.map((name) => `\`${name}\``).join(', ')}.`,
      `Sequential scans: ${seqScans.length === 0 ? 'none' : seqScans.join(', ')}.`,
      '',
      ...walkPlan(plan.Plan),
      '',
    );
  }
  lines.push(
    '## Findings',
    '',
    'The organization and user-account scans shown above are expected for the 100-row and 1,000-row dimension tables. The monthly Sandbox reservation count also scans all 100,000 rows because it aggregates every reservation for the month; its per-organization counterpart uses `sandbox_dispatch_reservations_month_idx`. The broad monthly metering and billing aggregates use the date BRIN index, with sequential scans for their organization/key dimensions.',
    '',
    `Usage retention measured ${usageSize === undefined ? 'an unknown table size' : `${Number(usageSize.rows).toLocaleString()} rows/${usageSize.totalBytes}`} and ${usageHeapScan?.['Actual Rows']?.toLocaleString() ?? 'an unknown number of'} expired candidates; the batch returned ${usageRetention?.plan.Plan['Actual Rows']?.toLocaleString() ?? 'an unreported number of'} rows in ${usageRetention?.plan['Execution Time'].toFixed(3) ?? 'an unreported'} ms. Its sort ${usageSortSummary}. The sibling dispatch batch took ${dispatchRetention?.plan['Execution Time'].toFixed(3) ?? 'an unreported'} ms. The \`(created_at, request_id)\` ordering gap is recorded as a follow-up in [#282](https://github.com/AiHub-Ecosystem/aihub-be/issues/282#issuecomment-6210953806); no index was added in this baseline.`,
    '',
    `The API-key lookup projects the fields consumed by \`ApiKeyRecord\` and does not select the stored key hash. Completed idempotency replay reads \`response_body\` for the replay response. The reviewed projections contain no unused wide fields; EXPLAIN exposes output columns but does not report TOAST fetches separately. Index-only scans observed: ${indexOnlyScanObserved ? 'yes.' : 'none; the selective lookups visit the heap for required projected fields. The plans do not justify an INCLUDE index.'}`,
    '',
    '## Scope and cadence',
    '',
    'This is a repeatable synthetic-data plan baseline. Rerun after changes to any listed query, index, or table schema, and at least quarterly. Compare plans and relation sizes; file index changes separately and only when the measured plan warrants them. Do not use these timings as a Production rate limit.',
    '',
    '## Downstream pool observation',
    '',
    'The gateway creates one Undici Pool per origin with 10 connections, HTTP/2 enabled, a 300,000 ms keep-alive timeout, and a 600,000 ms maximum. `bun run capacity:benchmark` records `downstreamQueuedPeak` from `aihub_downstream_pool_queued`; that is queue depth, not a socket-reuse or handshake counter. This database run does not make provider requests, so runtime connection reuse remains unmeasured.',
    '',
    'Production `pg_stat_statements` status is recorded in [the observability runbook](aihub-observability.md#statement-statistics-and-privacy-gate): as of 2026-10-16, version 1.10 was available but not installed in any connectable AIHUB database. #299 tracks queryable slow-statement evidence; this baseline did not change the shared cluster configuration.',
    '',
    'Recreate the baseline with `AIHUB_POSTGRES_BASELINE=1 bun run benchmark:postgres-plans` from PowerShell. The command requires the local `aihub` test-lane marker, takes the database-lane advisory lock, creates a uniquely named disposable database, applies checked-in migrations, seeds synthetic rows, writes this report, and drops only the database it created.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

export async function runPlanBaseline(
  pool: Pool,
  version: string,
): Promise<void> {
  const sizes = await tableSizes(pool);
  const stats = await pool.query(
    "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'",
  );
  const client = await pool.connect();
  const measured: { query: BaselineQuery; plan: PlanDocument }[] = [];
  try {
    for (const query of baselineQueries(new Date())) {
      measured.push({ query, plan: await explain(client, query) });
    }
  } finally {
    client.release();
  }
  if (measured.length !== 19) {
    throw new Error(`Expected 19 query plans, collected ${measured.length}`);
  }
  const report = renderReport(
    version,
    measured,
    sizes,
    (stats.rowCount ?? 0) > 0,
  );
  const reportPath = join(
    ROOT,
    'docs/operations/postgres-query-plan-baseline-results.md',
  );
  await writeFile(
    reportPath,
    await format(report, { filepath: reportPath }),
    'utf8',
  );
  process.stdout.write(
    `Wrote ${measured.length} query plans for PostgreSQL ${version} to ${reportPath}\n`,
  );
}
