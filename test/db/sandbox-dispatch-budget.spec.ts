import { PostgresSandboxDispatchBudget } from '@/modules/gateway/infrastructure/postgres-sandbox-dispatch-budget';
import { createSandboxTestPool, sandboxTestDatabaseUrl } from './database';

const ORGANIZATION_ID = 'org_budget_customer';
const NOW = new Date('2026-09-27T12:00:00.000Z');

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
});

afterAll(async () => {
  await budget.onModuleDestroy();
  await pool.end();
});

describe('Postgres Sandbox dispatch budget', () => {
  it('atomically enforces the per-Organization and shared monthly ceilings', async () => {
    const first = await budget.reserve({
      organizationId: ORGANIZATION_ID,
      requestId: 'request-1',
      organizationLimit: 2,
    });
    const second = await budget.reserve({
      organizationId: ORGANIZATION_ID,
      requestId: 'request-2',
      organizationLimit: 2,
    });
    const third = await budget.reserve({
      organizationId: ORGANIZATION_ID,
      requestId: 'request-3',
      organizationLimit: 2,
    });

    expect([first, second, third]).toEqual([true, true, false]);

    await pool.query(
      `INSERT INTO sandbox_dispatch_reservations
         (request_id, organization_id, month_start)
       SELECT 'seed-' || n, 'org_seed_' || n, DATE '2026-09-01'
       FROM generate_series(1, 497) AS n`,
    );
    await expect(
      budget.reserve({
        organizationId: 'org_last_allowed',
        requestId: 'request-500',
        organizationLimit: null,
      }),
    ).resolves.toBe(true);
    await expect(
      budget.reserve({
        organizationId: 'org_over_limit',
        requestId: 'request-501',
        organizationLimit: null,
      }),
    ).resolves.toBe(false);
  });

  it('serializes concurrent reservations and releases only the proven pre-dispatch reservation', async () => {
    const attempts = await Promise.all(
      ['request-a', 'request-b', 'request-c'].map((requestId) =>
        budget.reserve({
          organizationId: ORGANIZATION_ID,
          requestId,
          organizationLimit: 1,
        }),
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
        organizationLimit: 1,
      }),
    ).resolves.toBe(true);
  });

  it('starts a new allowance at the UTC month boundary', async () => {
    await budget.reserve({
      organizationId: ORGANIZATION_ID,
      requestId: 'september-request',
      organizationLimit: 1,
    });
    const octoberBudget = new PostgresSandboxDispatchBudget(
      sandboxTestDatabaseUrl(),
      () => new Date('2026-10-01T00:00:01.000Z'),
    );

    try {
      await expect(
        octoberBudget.reserve({
          organizationId: ORGANIZATION_ID,
          requestId: 'october-request',
          organizationLimit: 1,
        }),
      ).resolves.toBe(true);
    } finally {
      await octoberBudget.onModuleDestroy();
    }
  });
});
