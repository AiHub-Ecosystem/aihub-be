import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PostgresSandboxDispatchBudget } from '@/modules/gateway/infrastructure/postgres-sandbox-dispatch-budget';
import {
  createSandboxTestPool,
  sandboxTestDatabaseUrl,
} from '../shared/database';

const ORGANIZATION_ID = 'org_budget_customer';
const NOW = new Date('2026-09-27T12:00:00.000Z');
const SEPTEMBER = "DATE '2026-09-01'";
const OCTOBER = "DATE '2026-10-01'";

let pool: ReturnType<typeof createSandboxTestPool>;
let budget: PostgresSandboxDispatchBudget;

beforeAll(() => {
  pool = createSandboxTestPool();
  budget = new PostgresSandboxDispatchBudget(
    sandboxTestDatabaseUrl(),
    () => NOW,
  );
});

beforeEach(async () => {
  await pool.query('TRUNCATE sandbox_dispatch_reservations');
  await pool.query('TRUNCATE sandbox_allowance_overrides');
  await pool.query('TRUNCATE sandbox_allowance_defaults');
  await pool.query(
    `INSERT INTO sandbox_allowance_defaults (month_start, allowance) VALUES
       (${SEPTEMBER}, 5), (${OCTOBER}, 5)`,
  );
});

afterAll(async () => {
  await budget.onModuleDestroy();
  await pool.end();
});

describe('Postgres Sandbox dispatch budget', () => {
  it('atomically enforces the per-Organization and shared monthly ceilings', async () => {
    await pool.query(
      `INSERT INTO sandbox_allowance_overrides (organization_id, month_start, allowance)
       VALUES ($1, ${SEPTEMBER}, 2)`,
      [ORGANIZATION_ID],
    );
    const attempts = await Promise.all(
      ['request-1', 'request-2', 'request-3'].map((requestId) =>
        budget.reserve({ organizationId: ORGANIZATION_ID, requestId }),
      ),
    );

    expect(attempts.filter(Boolean)).toHaveLength(2);

    await pool.query(
      `INSERT INTO sandbox_dispatch_reservations
         (request_id, organization_id, month_start)
       SELECT 'seed-' || n, 'org_seed_' || n, ${SEPTEMBER}
       FROM generate_series(1, 497) AS n`,
    );
    await expect(
      budget.reserve({
        organizationId: 'org_last_allowed',
        requestId: 'r-499',
      }),
    ).resolves.toBe(true);
    await expect(
      budget.reserve({ organizationId: 'org_over_limit', requestId: 'r-501' }),
    ).resolves.toBe(false);
  });

  it('serializes concurrent reservations and releases only the proven pre-dispatch reservation', async () => {
    await pool.query(
      `INSERT INTO sandbox_allowance_overrides (organization_id, month_start, allowance)
       VALUES ($1, ${SEPTEMBER}, 1)`,
      [ORGANIZATION_ID],
    );
    const attempts = await Promise.all(
      ['request-a', 'request-b', 'request-c'].map((requestId) =>
        budget.reserve({ organizationId: ORGANIZATION_ID, requestId }),
      ),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);

    const acceptedRequest = await pool.query<{ request_id: string }>(
      `SELECT request_id FROM sandbox_dispatch_reservations
       WHERE organization_id = $1 AND status = 'reserved'`,
      [ORGANIZATION_ID],
    );
    const reservationId = acceptedRequest.rows[0]?.request_id;
    if (reservationId === undefined) {
      throw new Error('expected one active Sandbox reservation');
    }

    await budget.release(reservationId);
    await budget.release(reservationId);
    await expect(
      budget.reserve({
        organizationId: ORGANIZATION_ID,
        requestId: 'request-after-release',
      }),
    ).resolves.toBe(true);
  });

  it('applies the next month allowance once without carrying the previous month override', async () => {
    await pool.query(
      `INSERT INTO sandbox_allowance_overrides (organization_id, month_start, allowance)
       VALUES ($1, ${SEPTEMBER}, 1)`,
      [ORGANIZATION_ID],
    );
    await expect(
      budget.reserve({ organizationId: ORGANIZATION_ID, requestId: 'sept-1' }),
    ).resolves.toBe(true);
    await expect(
      budget.reserve({ organizationId: ORGANIZATION_ID, requestId: 'sept-2' }),
    ).resolves.toBe(false);

    const octoberBudget = new PostgresSandboxDispatchBudget(
      sandboxTestDatabaseUrl(),
      () => new Date('2026-10-01T00:00:01.000Z'),
    );
    try {
      await expect(
        octoberBudget.reserve({
          organizationId: ORGANIZATION_ID,
          requestId: 'oct-1',
        }),
      ).resolves.toBe(true);
      await expect(
        octoberBudget.allowanceFor(ORGANIZATION_ID),
      ).resolves.toEqual({
        monthlyLimit: 5,
        reserved: 1,
        sharedMonthlyLimit: 500,
        sharedReserved: 1,
      });
    } finally {
      await octoberBudget.onModuleDestroy();
    }
  });

  it('lets a lowering override block further dispatches without resetting what is consumed', async () => {
    await expect(
      budget.reserve({
        organizationId: ORGANIZATION_ID,
        requestId: 'before-1',
      }),
    ).resolves.toBe(true);
    await pool.query(
      `INSERT INTO sandbox_allowance_overrides (organization_id, month_start, allowance)
       VALUES ($1, ${SEPTEMBER}, 1)`,
      [ORGANIZATION_ID],
    );

    await expect(
      budget.reserve({ organizationId: ORGANIZATION_ID, requestId: 'after-1' }),
    ).resolves.toBe(false);
    await expect(budget.allowanceFor(ORGANIZATION_ID)).resolves.toEqual({
      monthlyLimit: 1,
      reserved: 1,
      sharedMonthlyLimit: 500,
      sharedReserved: 1,
    });
  });

  it('refuses every dispatch when the month has no persisted default', async () => {
    await pool.query('TRUNCATE sandbox_allowance_defaults');
    await pool.query(
      `INSERT INTO sandbox_allowance_defaults (month_start, allowance)
       VALUES (${OCTOBER}, 5)`,
    );

    await expect(
      budget.reserve({
        organizationId: ORGANIZATION_ID,
        requestId: 'no-policy',
      }),
    ).rejects.toThrow('Sandbox allowance policy is unavailable');
    await expect(budget.allowanceFor(ORGANIZATION_ID)).resolves.toBeNull();
  });
});

describe('migration 0037 deployment-month seed', () => {
  const MIGRATION = readFileSync(
    join(
      __dirname,
      '../../../prisma/migrations/0037_sandbox_allowance_policy/migration.sql',
    ),
    'utf8',
  );
  const SEED = MIGRATION.slice(
    MIGRATION.indexOf('INSERT INTO sandbox_allowance_defaults'),
  );

  /** Runs the migration's seed as if it executed at `deployedAt`. */
  async function seedAt(deployedAt: string): Promise<void> {
    await pool.query('TRUNCATE sandbox_allowance_defaults');
    await pool.query(SEED.replaceAll('now()', `TIMESTAMPTZ '${deployedAt}'`));
  }

  async function allowanceAt(now: string, organizationId: string) {
    const instance = new PostgresSandboxDispatchBudget(
      sandboxTestDatabaseUrl(),
      () => new Date(now),
    );
    try {
      return (await instance.allowanceFor(organizationId))?.monthlyLimit;
    } finally {
      await instance.onModuleDestroy();
    }
  }

  it('keeps the allowance in effect for the deployment month and starts 5 the next UTC month', async () => {
    await seedAt('2026-10-31T23:30:00Z');

    expect(await allowanceAt('2026-10-31T23:59:59Z', 'org_any')).toBe(25);
    expect(await allowanceAt('2026-11-01T00:00:00Z', 'org_any')).toBe(5);
    expect(await allowanceAt('2027-03-15T00:00:00Z', 'org_any')).toBe(5);
  });

  it('reads the deployment month in UTC, not in the migration session time zone', async () => {
    await pool.query('TRUNCATE sandbox_allowance_defaults');
    // One connection, so the session time zone applies to the seed itself.
    const session = await pool.connect();
    try {
      await session.query("SET TIME ZONE 'Asia/Ho_Chi_Minh'");
      await session.query(
        SEED.replaceAll('now()', "TIMESTAMPTZ '2026-10-31T20:00:00Z'"),
      );
    } finally {
      await session.query('RESET TIME ZONE');
      session.release();
    }

    expect(await allowanceAt('2026-10-31T21:00:00Z', 'org_any')).toBe(25);
    expect(await allowanceAt('2026-11-01T00:00:00Z', 'org_any')).toBe(5);
  });

  it('leaves an allowance an operator already set for the deployment month', async () => {
    await pool.query('TRUNCATE sandbox_allowance_defaults');
    await pool.query(
      `INSERT INTO sandbox_allowance_defaults (month_start, allowance)
       VALUES (DATE '2026-10-01', 40)`,
    );
    await pool.query(
      SEED.replaceAll('now()', "TIMESTAMPTZ '2026-10-13T00:00:00Z'"),
    );

    expect(await allowanceAt('2026-10-20T00:00:00Z', 'org_any')).toBe(40);
    expect(await allowanceAt('2026-11-02T00:00:00Z', 'org_any')).toBe(5);
  });
});
