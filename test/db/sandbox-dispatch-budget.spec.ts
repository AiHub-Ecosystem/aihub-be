import { PostgresSandboxDispatchBudget } from '@/modules/gateway/infrastructure/postgres-sandbox-dispatch-budget';
import { createSandboxTestPool, sandboxTestDatabaseUrl } from './database';

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
