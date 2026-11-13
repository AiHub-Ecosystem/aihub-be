import type { Pool, PoolClient } from 'pg';

import { runBillingAdjustCommand } from '@/cli/billing-statement';
import {
  BillingStatementService,
  parseBillingMonth,
} from '@/modules/metering/application/billing/billing-statement';
import { MeteringService } from '@/modules/metering/application/usage-recording/metering.service';
import { PostgresBillingStatementRepository } from '@/modules/metering/infrastructure/billing/postgres-billing-statement.repository';
import { PostgresMonthlyBillableUsage } from '@/modules/metering/infrastructure/billing/postgres-monthly-billable-usage';
import {
  PostgresUsageRepository,
  createPostgresMeteringClient,
} from '@/modules/metering/infrastructure/usage-recording/postgres-usage.repository';
import type { PrismaMeteringClient } from '@/modules/metering/infrastructure/usage-recording/prisma-metering.client';
import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../shared/database';

const ORG = 'org_billing';
const OTHER = 'org_other';
const OCTOBER = parseBillingMonth('2026-10');
const AFTER_OCTOBER = new Date('2026-11-02T00:00:00Z');

let pool: Pool;
let client: PrismaMeteringClient;
let repository: PostgresBillingStatementRepository;
let service: BillingStatementService;
let monthlyUsage: PostgresMonthlyBillableUsage;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresMeteringClient(testDatabaseUrl());
  repository = new PostgresBillingStatementRepository(client);
  service = new BillingStatementService(repository);
  monthlyUsage = new PostgresMonthlyBillableUsage(client);
});

afterAll(async () => {
  await client.$disconnect();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
  await pool.query('TRUNCATE usage_records');
  for (const id of [ORG, OTHER]) {
    await pool.query(
      `INSERT INTO organizations (id, name, status, entitlements)
       VALUES ($1, $1, 'active', ARRAY['writing'])`,
      [id],
    );
  }
  await key('ak_customer', ORG, false);
  await key('ak_internal', ORG, true);
  await key('ak_other', OTHER, false);
});

async function key(id: string, organizationId: string, internal: boolean) {
  await pool.query(
    `INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, name, internal)
     VALUES ($1, $2, sha256(convert_to($1, 'UTF8')), 'aihub_prod_x', $1, $3)`,
    [id, organizationId, internal],
  );
}

let sequence = 0;
async function usage(row: {
  readonly at: string;
  readonly organizationId?: string;
  readonly apiKeyId?: string;
  readonly actorId?: string;
  readonly outcome?: string;
  readonly billable?: 0 | 1;
  readonly environment?: string;
  readonly basis?: string;
  readonly status?: string;
}) {
  sequence += 1;
  await pool.query(
    `INSERT INTO usage_records (
       request_id, organization_id, api_key_id, actor_id, service, operation, environment,
       outcome, http_status, billable_requests, metering_status, total_ms,
       billing_basis, created_at)
     VALUES ($1, $2, $3, $4, 'writing', 'writing.task2.grade', $5, $6, $7, $8, $9, 10, $10, $11)`,
    [
      `req_billing_${sequence}`,
      row.organizationId ?? ORG,
      row.apiKeyId ?? 'ak_customer',
      row.actorId ?? null,
      row.environment ?? 'production',
      row.outcome ?? 'success',
      (row.outcome ?? 'success') === 'success' ? 200 : 504,
      row.billable ?? 1,
      row.status ?? 'not_applicable',
      row.basis ?? 'response',
      row.at,
    ],
  );
}

function lineFor(statement: Awaited<ReturnType<typeof service.statement>>) {
  return statement.lines.find((line) => line.organizationId === ORG);
}

const adjustmentCliInput = {
  id: 'badj_01J00000000000000000000011',
  organizationId: ORG,
  month: '2026-10',
  operation: 'writing.task2.grade',
  requests: -1,
  reason: 'Incident 2026-10-05: correction',
  corrects: { requestIds: ['req_billing_x'] },
  actor: 'operator_a',
};

async function runAdjustmentCli(
  overrides: Partial<typeof adjustmentCliInput> = {},
) {
  const output: string[] = [];
  const id = await runBillingAdjustCommand({
    databaseUrl: testDatabaseUrl(),
    ...adjustmentCliInput,
    repository: new PostgresBillingStatementRepository(
      createPostgresMeteringClient(testDatabaseUrl()),
    ),
    emit: (line) => output.push(line),
    ...overrides,
  });
  return { id, output };
}

describe('billing statement', () => {
  it('counts a successful usage row written by the metering finalizer for the same month', async () => {
    const finalizer = new MeteringService(new PostgresUsageRepository(client));
    const occurredAt = new Date('2026-10-15T08:00:00Z');
    await client.$connect();

    await finalizer.finalize({
      requestId: 'req_billing_finalizer_count',
      organizationId: ORG,
      apiKeyId: 'ak_customer',
      operation: 'writing.task1.grade',
      environment: 'production',
      outcome: 'success',
      httpStatus: 200,
      totalMs: 10,
      occurredAt,
    });

    const persisted = await pool.query<{
      readonly outcome: string;
      readonly billable_requests: number;
      readonly created_at: Date;
    }>(
      `SELECT outcome, billable_requests, created_at FROM usage_records
       WHERE request_id = 'req_billing_finalizer_count'`,
    );
    expect(persisted.rows[0]).toMatchObject({
      outcome: 'success',
      billable_requests: 1,
      created_at: occurredAt,
    });

    await expect(
      monthlyUsage.billableCount(ORG, OCTOBER.from, OCTOBER.to),
    ).resolves.toBe(1);
  });

  it('bills one UTC month of successful, non-replayed Production customer requests', async () => {
    await usage({ at: '2026-09-30T23:59:59Z' }); // the month before
    await usage({ at: '2026-10-01T00:00:00Z' }); // first instant: billed
    await usage({ at: '2026-10-15T08:00:00Z', status: 'quota_unverified' });
    await usage({ at: '2026-10-15T08:00:01Z', billable: 0 }); // replay
    await usage({
      at: '2026-10-15T08:00:02Z',
      outcome: 'downstream_error',
      billable: 0,
    });
    await usage({ at: '2026-10-15T08:00:03Z', basis: 'background_completion' });
    await usage({ at: '2026-10-16T00:00:00Z', apiKeyId: 'ak_internal' });
    await usage({ at: '2026-10-16T00:00:01Z', environment: 'sandbox' });
    await usage({
      at: '2026-10-20T00:00:00Z',
      organizationId: OTHER,
      apiKeyId: 'ak_other',
    });
    await usage({ at: '2026-11-01T00:00:00Z' }); // first instant of the next month

    const statement = await service.statement({
      month: OCTOBER,
      organizationId: ORG,
      now: AFTER_OCTOBER,
    });

    expect(statement.lines).toEqual([
      {
        organizationId: ORG,
        operation: 'writing.task2.grade',
        billableRequests: 3,
        backgroundCompletionRequests: 1,
        adjustmentRequests: 0,
        totalRequests: 3,
        quotaUnverified: 1,
        excludedReplays: 1,
        excludedFailures: 1,
        excludedInternal: 1,
        excludedNonProduction: 1,
      },
    ]);
  });

  it('scopes usage reads by Organization when both Organizations share an actor id', async () => {
    await usage({
      at: '2026-10-05T00:00:00Z',
      organizationId: ORG,
      actorId: 'student-shared',
    });
    await usage({
      at: '2026-10-05T00:00:00Z',
      organizationId: OTHER,
      apiKeyId: 'ak_other',
      actorId: 'student-shared',
    });

    await expect(repository.snapshot(OCTOBER, ORG)).resolves.toMatchObject({
      usage: [expect.objectContaining({ organizationId: ORG })],
    });
    await expect(repository.snapshot(OCTOBER, OTHER)).resolves.toMatchObject({
      usage: [expect.objectContaining({ organizationId: OTHER })],
    });
    await expect(
      monthlyUsage.billableCount(ORG, OCTOBER.from, OCTOBER.to),
    ).resolves.toBe(1);
    await expect(
      monthlyUsage.billableCount(OTHER, OCTOBER.from, OCTOBER.to),
    ).resolves.toBe(1);
  });

  it('adds adjustments beside the evidence without editing it', async () => {
    await usage({ at: '2026-10-05T00:00:00Z' });
    await service.adjust({
      id: 'badj_01J00000000000000000000001',
      organizationId: ORG,
      month: OCTOBER,
      operation: 'writing.task2.grade',
      requests: -1,
      reason: 'Incident 2026-10-05: contract-valid but wrong scores',
      corrects: { requestIds: ['req_billing_x'] },
      actor: 'operator_a',
    });

    const statement = await service.statement({
      month: OCTOBER,
      organizationId: ORG,
      now: AFTER_OCTOBER,
    });

    const usageRows = (
      await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM usage_records',
      )
    ).rows[0]?.n;
    expect(lineFor(statement)).toMatchObject({
      billableRequests: 1,
      adjustmentRequests: -1,
      totalRequests: 0,
    });
    expect(statement.adjustments.map((a) => [a.requests, a.actor])).toEqual([
      [-1, 'operator_a'],
    ]);
    expect(usageRows).toBe(1);
    await expect(pool.query('DELETE FROM billing_adjustments')).rejects.toThrow(
      'billing_adjustments is append-only',
    );
  });

  it('reuses the same durable adjustment identity after lost CLI output', async () => {
    await usage({ at: '2026-10-05T00:00:00Z' });

    const first = await runAdjustmentCli();
    const retry = await runAdjustmentCli();
    const statement = await service.statement({
      month: OCTOBER,
      organizationId: ORG,
      now: AFTER_OCTOBER,
    });

    expect(first.id).toBe(adjustmentCliInput.id);
    expect(retry.id).toBe(first.id);
    expect(retry.output).toContain(
      JSON.stringify({
        event: 'billing_adjustment_reused',
        id: first.id,
        month: '2026-10',
        organization_id: ORG,
        operation: 'writing.task2.grade',
        requests: -1,
      }),
    );
    expect(statement.adjustments).toHaveLength(1);
    expect(lineFor(statement)).toMatchObject({
      adjustmentRequests: -1,
      totalRequests: 0,
    });
  });

  it.each([
    ['another Organization', { organizationId: OTHER }],
    ['another month', { month: '2026-11' }],
    ['a different payload', { requests: -2 }],
  ])('rejects reuse of one identity for %s', async (_label, override) => {
    await runAdjustmentCli();

    await expect(runAdjustmentCli(override)).rejects.toMatchObject({
      code: 'BILLING_INVALID_ADJUSTMENT',
      message: 'adjustment id was reused with different values',
    });
    const count = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM billing_adjustments',
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('serializes concurrent retries with one identity to one adjustment', async () => {
    const [first, second] = await Promise.all([
      runAdjustmentCli(),
      runAdjustmentCli(),
    ]);
    const statement = await service.statement({
      month: OCTOBER,
      organizationId: ORG,
      now: AFTER_OCTOBER,
    });

    expect(first.id).toBe(second.id);
    expect(statement.adjustments).toHaveLength(1);
    expect(lineFor(statement)).toMatchObject({
      adjustmentRequests: -1,
      totalRequests: -1,
    });
  });

  it('allows a second intended adjustment with a fresh identity', async () => {
    await runAdjustmentCli();
    await runAdjustmentCli({ id: 'badj_01J00000000000000000000012' });
    const statement = await service.statement({
      month: OCTOBER,
      organizationId: ORG,
      now: AFTER_OCTOBER,
    });

    expect(statement.adjustments).toHaveLength(2);
    expect(lineFor(statement)).toMatchObject({
      adjustmentRequests: -2,
      totalRequests: -2,
    });
  });

  it('closes a month once and then reports, never rewrites, a later difference', async () => {
    await usage({ at: '2026-10-05T00:00:00Z' });
    await usage({ at: '2026-10-06T00:00:00Z' });

    await expect(
      service.statement({
        month: OCTOBER,
        organizationId: ORG,
        closeAs: 'operator_a',
        now: new Date('2026-10-31T23:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'BILLING_MONTH_NOT_ENDED' });

    const closed = await service.statement({
      month: OCTOBER,
      organizationId: ORG,
      closeAs: 'operator_a',
      now: AFTER_OCTOBER,
    });
    expect(closed.closed.map((c) => c.closedBy)).toEqual(['operator_a']);
    expect(closed.differences).toEqual([]);

    // A prune or a restore changes the evidence after the month was billed.
    await pool.query(
      "DELETE FROM usage_records WHERE created_at = '2026-10-06T00:00:00Z'",
    );
    const rerun = await service.statement({
      month: OCTOBER,
      organizationId: ORG,
      closeAs: 'operator_b',
      now: AFTER_OCTOBER,
    });

    expect({
      closedBy: rerun.closed.map((c) => c.closedBy),
      differences: rerun.differences,
      stored: (
        await pool.query(
          'SELECT total_requests, closed_by FROM billing_month_closures WHERE organization_id = $1',
          [ORG],
        )
      ).rows,
    }).toEqual({
      closedBy: ['operator_a'],
      differences: [
        {
          organizationId: ORG,
          operation: 'writing.task2.grade',
          closedTotal: 2,
          currentTotal: 1,
        },
      ],
      stored: [{ total_requests: 2, closed_by: 'operator_a' }],
    });
    await expect(
      service.adjust({
        id: 'badj_01J00000000000000000000002',
        organizationId: ORG,
        month: OCTOBER,
        operation: 'writing.task2.grade',
        requests: 1,
        reason: 'late evidence',
        corrects: {
          period: { from: '2026-10-06T00:00:00Z', to: '2026-10-07T00:00:00Z' },
        },
        actor: 'operator_b',
      }),
    ).rejects.toMatchObject({ code: 'BILLING_MONTH_CLOSED' });
  });
});

/** A backend is waiting on a lock while running a query matching `pattern`. */
async function waitForBlocked(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid() AND query LIKE $1`,
      [pattern],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no backend blocked on ${pattern}`);
}

const openHolders = new Set<PoolClient>();

/** Holds a table lock in an open transaction until the caller commits it. */
async function holdTableLock(table: string, mode: string) {
  const holder = await pool.connect();
  openHolders.add(holder);
  await holder.query('BEGIN');
  await holder.query(`LOCK TABLE ${table} IN ${mode} MODE`);
  return holder;
}

async function commitHolder(holder: PoolClient): Promise<void> {
  await holder.query('COMMIT');
  openHolders.delete(holder);
  holder.release();
}

// A failing test must not leave a lock open for the next one.
afterEach(async () => {
  for (const holder of openHolders) {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
  openHolders.clear();
});

const ADVISORY_WAIT = 'SELECT pg_advisory_xact_lock%';
const lateAdjustment = {
  id: 'badj_01J00000000000000000000021',
  organizationId: ORG,
  month: OCTOBER,
  operation: 'writing.task2.grade',
  requests: -1,
  reason: 'overlaps the close',
  corrects: { requestIds: ['req_billing_x'] },
  actor: 'operator_b',
};

describe('billing statement concurrency (#999)', () => {
  it('closes a month with the adjustment that was in flight when the close started', async () => {
    await usage({ at: '2026-10-05T00:00:00Z' });
    // The adjustment has passed its closed-month check and waits to insert.
    const holder = await holdTableLock('billing_adjustments', 'SHARE');
    const adjusting = service.adjust(lateAdjustment);
    await waitForBlocked('%billing_adjustments%');
    const closing = service.statement({
      month: OCTOBER,
      organizationId: ORG,
      closeAs: 'operator_a',
      now: AFTER_OCTOBER,
    });
    await waitForBlocked(ADVISORY_WAIT);
    await commitHolder(holder);

    await expect(adjusting).resolves.toBe('created');
    const closed = await closing;
    const stored = await pool.query(
      `SELECT billable_requests, adjustment_requests, total_requests
       FROM billing_month_closures WHERE organization_id = $1`,
      [ORG],
    );

    expect(closed.differences).toEqual([]);
    expect(stored.rows).toEqual([
      { billable_requests: 1, adjustment_requests: -1, total_requests: 0 },
    ]);
  });

  it('refuses an adjustment that arrives while the month close is in flight', async () => {
    await usage({ at: '2026-10-05T00:00:00Z' });
    // The close has read its totals and waits to write the closure.
    const holder = await holdTableLock('billing_month_closures', 'SHARE');
    const closing = service.statement({
      month: OCTOBER,
      organizationId: ORG,
      closeAs: 'operator_a',
      now: AFTER_OCTOBER,
    });
    await waitForBlocked('%billing_month_closures%');
    const refused = service
      .adjust(lateAdjustment)
      .catch((error: unknown) => error);
    await waitForBlocked(ADVISORY_WAIT);
    await commitHolder(holder);

    const closed = await closing;
    expect(await refused).toMatchObject({ code: 'BILLING_MONTH_CLOSED' });
    expect(closed.differences).toEqual([]);
    await expect(
      pool.query('SELECT 1 FROM billing_adjustments'),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('never combines usage from before a concurrent change with adjustments from after it', async () => {
    await usage({ at: '2026-10-05T00:00:00Z' });
    // The statement has read usage and waits on the adjustments read.
    const holder = await holdTableLock(
      'billing_adjustments',
      'ACCESS EXCLUSIVE',
    );
    const reading = service.statement({
      month: OCTOBER,
      organizationId: ORG,
      now: AFTER_OCTOBER,
    });
    await waitForBlocked('%billing_adjustments%');
    await usage({ at: '2026-10-06T00:00:00Z' });
    await holder.query(
      `INSERT INTO billing_adjustments (
         id, organization_id, billing_month, operation, requests, reason,
         corrects, actor)
       VALUES ($1, $2, '2026-10-01', 'writing.task2.grade', -1, 'concurrent',
         '{"request_ids":["req_billing_x"]}', 'operator_b')`,
      [lateAdjustment.id, ORG],
    );
    await commitHolder(holder);

    // Total 1 before the change, 1 after it (2 requests, one credit). A mix of
    // old usage and the new credit would read 0, a total that never existed.
    expect(lineFor(await reading)).toMatchObject({
      billableRequests: 1,
      adjustmentRequests: 0,
      totalRequests: 1,
    });
  });

  it('never combines usage and adjustments from before a concurrent close with its closure', async () => {
    await usage({ at: '2026-10-05T00:00:00Z' });
    // The statement has read usage and adjustments and waits on the closures.
    const holder = await holdTableLock(
      'billing_month_closures',
      'ACCESS EXCLUSIVE',
    );
    const reading = service.statement({
      month: OCTOBER,
      organizationId: ORG,
      now: AFTER_OCTOBER,
    });
    await waitForBlocked('%billing_month_closures%');
    await holder.query(
      `INSERT INTO billing_month_closures (
         organization_id, billing_month, operation, billable_requests,
         adjustment_requests, total_requests, closed_by)
       VALUES ($1, '2026-10-01', 'writing.task2.grade', 5, 0, 5, 'operator_b')`,
      [ORG],
    );
    await commitHolder(holder);

    // The closure committed after the snapshot, so the statement shows an
    // open month; a closure beside pre-close usage would report a difference.
    expect(await reading).toMatchObject({ closed: [], differences: [] });
  });
});
