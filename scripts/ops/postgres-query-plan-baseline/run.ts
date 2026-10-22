import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { BASELINE, TARGET_ORGANIZATION_ID } from './config';
import { runPlanBaseline } from './plans';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_ADMIN_URL = BASELINE.defaultAdminUrl;
const DATABASE_LANE_LOCK_KEY = BASELINE.databaseLaneLockKey;
const ORGANIZATION_COUNT = BASELINE.organizationCount;
const API_KEY_COUNT = BASELINE.apiKeyCount;
const USER_COUNT = BASELINE.userCount;
const MEMBERSHIP_COUNT = BASELINE.membershipCount;
const USAGE_RECORD_COUNT = BASELINE.usageRecordCount;
const IDEMPOTENCY_RECORD_COUNT = BASELINE.idempotencyRecordCount;
const DISPATCH_ATTEMPT_COUNT = BASELINE.dispatchAttemptCount;
const SANDBOX_RESERVATION_COUNT = BASELINE.sandboxReservationCount;
const RETENTION_SPAN_SECONDS = BASELINE.retentionSpanSeconds;

function localAdminUrl(): string {
  if (process.env.AIHUB_POSTGRES_BASELINE !== '1') {
    throw new Error(
      'Set AIHUB_POSTGRES_BASELINE=1 to create and drop a disposable local database',
    );
  }

  const connectionString =
    process.env.DB_LANE_ADMIN_URL?.trim() || DEFAULT_ADMIN_URL;
  const url = new URL(connectionString);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '5432' ||
    url.pathname !== '/aihub' ||
    url.searchParams.has('host') ||
    url.searchParams.has('hostaddr')
  ) {
    throw new Error(
      'The query-plan baseline is restricted to the local aihub test database on port 5432',
    );
  }

  return connectionString;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function assertDisposableDatabase(pool: Pool): Promise<string> {
  const result = await pool.query<{
    readonly version: string;
    readonly versionNumber: string;
    readonly marker: string | null;
  }>(`
    SELECT current_setting('server_version') AS version,
           current_setting('server_version_num') AS "versionNumber",
           current_setting('aihub.test_lane_marker', true) AS marker
  `);
  const row = result.rows[0];
  if (row === undefined || !row.versionNumber.startsWith('16')) {
    throw new Error(
      `The query-plan baseline requires PostgreSQL 16; found ${row?.version ?? 'no server'}`,
    );
  }
  if (row.marker !== 'aihub_db_lane_v1') {
    throw new Error(
      'The local aihub database lane marker is missing; refusing to create a database',
    );
  }
  const lock = await pool.query<{ readonly acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1, $2) AS acquired',
    [...DATABASE_LANE_LOCK_KEY],
  );
  if (lock.rows[0]?.acquired !== true) {
    throw new Error(
      'The PostgreSQL database validation lane is already running',
    );
  }
  return row.version;
}

function applyMigrations(databaseUrl: string): void {
  execFileSync(process.execPath, ['scripts/cli/migrate.mjs'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}

async function seedDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO organizations (
      id, name, status, entitlements, monthly_request_quota
    )
    SELECT 'bench_org_' || lpad(n::text, 3, '0'),
           'Query plan benchmark ' || n::text,
           'active', ARRAY['speaking', 'writing'], 1000000
    FROM generate_series(0, ${ORGANIZATION_COUNT - 1}) AS n
  `);
  await pool.query(`
    INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, name)
    SELECT 'bench_key_' || lpad(n::text, 6, '0'),
           'bench_org_' || lpad(((n - 1) % ${ORGANIZATION_COUNT})::text, 3, '0'),
           decode(lpad(to_hex(n::bigint), 64, '0'), 'hex'),
           'bench', 'Query plan benchmark key'
    FROM generate_series(1, ${API_KEY_COUNT}) AS n
  `);
  await pool.query(`
    INSERT INTO user_accounts (id, username, status, created_at, updated_at)
    SELECT 'usr_' || lpad(n::text, 26, '0'),
           'bench-user-' || lpad(n::text, 4, '0'),
           'active', now(), now()
    FROM generate_series(1, ${USER_COUNT}) AS n
  `);
  await pool.query(`
    INSERT INTO organization_members (
      organization_id, user_account_id, role, status
    )
    SELECT 'bench_org_' || lpad(((n - 1) / ${USER_COUNT})::text, 3, '0'),
           'usr_' || lpad((((n - 1) % ${USER_COUNT}) + 1)::text, 26, '0'),
           CASE WHEN (n - 1) % ${USER_COUNT} = 0 THEN 'owner' ELSE 'member' END,
           'active'
    FROM generate_series(1, ${MEMBERSHIP_COUNT}) AS n
  `);
  await pool.query(`
    INSERT INTO usage_records (
      request_id, organization_id, api_key_id, actor_id, service, operation,
      environment, outcome, http_status, billable_requests, input_tokens,
      output_tokens, total_tokens, metering_status, total_ms, downstream_ms,
      ai_processing_ms, created_at
    )
    SELECT 'bench_usage_' || lpad(n::text, 7, '0'),
           'bench_org_' || lpad(((n - 1) % ${ORGANIZATION_COUNT})::text, 3, '0'),
           'bench_key_' || lpad(((n - 1) % ${API_KEY_COUNT} + 1)::text, 6, '0'),
           'bench-actor',
           CASE WHEN n % 4 < 2 THEN 'ai-writing' ELSE 'ai-speaking' END,
           CASE n % 4 WHEN 0 THEN 'writing.task1.grade'
             WHEN 1 THEN 'writing.task2.grade'
             WHEN 2 THEN 'speaking.grade' ELSE 'speaking.grade-json' END,
           'production',
           CASE WHEN n % 5 = 0 THEN 'downstream_error' ELSE 'success' END,
           CASE WHEN n % 5 = 0 THEN 502 ELSE 200 END,
           CASE WHEN n % 5 = 0 THEN 0 ELSE 1 END,
           CASE WHEN n % 5 = 0 OR n % 29 = 0 THEN NULL ELSE (n % 50)::int END,
           CASE WHEN n % 5 = 0 OR n % 29 = 0 THEN NULL ELSE (n % 50)::int END,
           CASE WHEN n % 5 = 0 OR n % 29 = 0 THEN NULL ELSE (n % 100)::int END,
           CASE WHEN n % 5 <> 0 AND n % 29 = 0 THEN 'missing_usage' ELSE 'complete' END,
           (n % 1000)::int, (n % 900)::int, (n % 900)::int,
           now() - (${RETENTION_SPAN_SECONDS}::double precision * interval '1 second')
             + (n::double precision / ${USAGE_RECORD_COUNT} * ${RETENTION_SPAN_SECONDS} * interval '1 second')
    FROM generate_series(1, ${USAGE_RECORD_COUNT}) AS n
    ORDER BY n
  `);
  await pool.query(`
    INSERT INTO idempotency_records (
      organization_id, operation, actor_scope, idempotency_key,
      request_fingerprint, state, request_id, response_status, response_body,
      created_at, completed_at, expires_at
    )
    SELECT 'bench_org_' || lpad(((n - 1) % ${ORGANIZATION_COUNT})::text, 3, '0'),
           'writing.task2.grade', 'baseline',
           CASE WHEN n = ${IDEMPOTENCY_RECORD_COUNT}
             THEN 'baseline-conflict'
             ELSE 'bench-idem-' || lpad(n::text, 7, '0') END,
           decode(lpad(to_hex(n::bigint), 64, '0'), 'hex'),
           'completed', 'bench_idem_' || lpad(n::text, 7, '0'), 200,
           '{"benchmark":true}'::jsonb, now() - interval '1 day',
           now() - interval '1 day',
           CASE WHEN n = ${IDEMPOTENCY_RECORD_COUNT} OR n % 2 = 1
             THEN now() + interval '1 day'
             ELSE now() - interval '1 day' END
    FROM generate_series(1, ${IDEMPOTENCY_RECORD_COUNT}) AS n
  `);
  await pool.query(`
    INSERT INTO dispatch_attempts (
      attempt_id, request_id, organization_id, operation,
      created_at, unknown_after, outcome
    )
    SELECT md5('bench_attempt_' || n::text)::uuid,
           'bench_usage_' || lpad(n::text, 7, '0'),
           'bench_org_' || lpad(((n - 1) % ${ORGANIZATION_COUNT})::text, 3, '0'),
           'writing.task2.grade',
           created_at, created_at + interval '1 minute', 'response_received'
    FROM (
      SELECT n,
             now() - (${RETENTION_SPAN_SECONDS}::double precision * interval '1 second')
               + (n::double precision / ${DISPATCH_ATTEMPT_COUNT} * ${RETENTION_SPAN_SECONDS} * interval '1 second') AS created_at
      FROM generate_series(1, ${DISPATCH_ATTEMPT_COUNT}) AS n
    ) AS attempts
    ORDER BY attempts.n
  `);
  await pool.query(`
    INSERT INTO sandbox_allowance_overrides (organization_id, month_start, allowance)
    VALUES ('${TARGET_ORGANIZATION_ID}', date_trunc('month', now() AT TIME ZONE 'UTC')::date, 1000)
  `);
  await pool.query(`
    INSERT INTO sandbox_dispatch_reservations (request_id, organization_id, month_start)
    SELECT 'bench_reservation_' || lpad(n::text, 7, '0'),
           'bench_org_' || lpad(((n - 1) % ${ORGANIZATION_COUNT})::text, 3, '0'),
           date_trunc('month', now() AT TIME ZONE 'UTC')::date
    FROM generate_series(1, ${SANDBOX_RESERVATION_COUNT}) AS n
  `);

  await pool.query(`
    ANALYZE organizations;
    ANALYZE api_keys;
    ANALYZE user_accounts;
    ANALYZE organization_members;
    ANALYZE idempotency_records;
    ANALYZE sandbox_dispatch_reservations;
    ANALYZE usage_records;
    ANALYZE dispatch_attempts;
  `);

  const counts = await pool.query<{
    readonly organizations: string;
    readonly apiKeys: string;
    readonly users: string;
    readonly memberships: string;
    readonly usageRecords: string;
    readonly idempotencyRecords: string;
    readonly dispatchAttempts: string;
    readonly sandboxReservations: string;
  }>(`
    SELECT (SELECT count(*) FROM organizations) AS organizations,
           (SELECT count(*) FROM api_keys) AS "apiKeys",
           (SELECT count(*) FROM user_accounts) AS users,
           (SELECT count(*) FROM organization_members) AS memberships,
           (SELECT count(*) FROM usage_records) AS "usageRecords",
           (SELECT count(*) FROM idempotency_records) AS "idempotencyRecords",
           (SELECT count(*) FROM dispatch_attempts) AS "dispatchAttempts",
           (SELECT count(*) FROM sandbox_dispatch_reservations) AS "sandboxReservations"
  `);
  const expected = {
    organizations: ORGANIZATION_COUNT,
    apiKeys: API_KEY_COUNT,
    users: USER_COUNT,
    memberships: MEMBERSHIP_COUNT,
    usageRecords: USAGE_RECORD_COUNT,
    idempotencyRecords: IDEMPOTENCY_RECORD_COUNT,
    dispatchAttempts: DISPATCH_ATTEMPT_COUNT,
    sandboxReservations: SANDBOX_RESERVATION_COUNT,
  };
  if (
    JSON.stringify(counts.rows[0]) !==
    JSON.stringify(
      Object.fromEntries(
        Object.entries(expected).map(([key, value]) => [key, String(value)]),
      ),
    )
  ) {
    throw new Error(
      `Synthetic baseline row counts did not match: ${JSON.stringify(counts.rows[0])}`,
    );
  }
}

async function main(): Promise<void> {
  const adminUrl = localAdminUrl();
  const adminPool = new Pool({
    connectionString: adminUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    application_name: 'aihub-postgres-query-plan-baseline',
  });
  let lockAcquired = false;
  let databaseCreated = false;
  let databaseName = '';
  let planPool: Pool | undefined;
  try {
    const version = await assertDisposableDatabase(adminPool);
    lockAcquired = true;
    databaseName = `aihub_plan_${process.pid}_${Date.now().toString(36)}`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    applyMigrations(databaseUrl.toString());
    planPool = new Pool({
      connectionString: databaseUrl.toString(),
      max: 1,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 300_000,
      application_name: 'aihub-postgres-query-plan-baseline',
    });
    await seedDatabase(planPool);
    await runPlanBaseline(planPool, version);
  } finally {
    try {
      try {
        await planPool?.end();
      } finally {
        if (databaseCreated) {
          await adminPool.query(
            `DROP DATABASE ${quoteIdentifier(databaseName)}`,
          );
        }
      }
    } finally {
      try {
        if (lockAcquired) {
          await adminPool.query('SELECT pg_advisory_unlock($1, $2)', [
            ...DATABASE_LANE_LOCK_KEY,
          ]);
        }
      } finally {
        await adminPool.end();
      }
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  process.stderr.write(`PostgreSQL query-plan baseline failed: ${message}\n`);
  process.exitCode = 1;
});
