import { emailDailySendBudgetLimits } from '@/modules/auth/email-delivery/application/email-send-daily-budget.policy';
import { PostgresEmailDailySendBudget } from '@/modules/auth/email-delivery/infrastructure/postgres-email-daily-send-budget';
import { createTestPool, resetIdentityTables } from '../shared/database';

describe('shared durable Resend daily budget', () => {
  const firstPool = createTestPool();
  const secondPool = createTestPool();
  const firstDeployment = new PostgresEmailDailySendBudget(
    () => firstPool,
    emailDailySendBudgetLimits(10),
  );
  const secondDeployment = new PostgresEmailDailySendBudget(
    () => secondPool,
    emailDailySendBudgetLimits(10),
  );

  beforeEach(async () => {
    await resetIdentityTables(firstPool);
  });

  afterAll(async () => {
    await Promise.all([firstPool.end(), secondPool.end()]);
  });

  it('keeps reservations within the shared caps when invitations and priority mail race across two connections', async () => {
    const [invitations, priority] = await Promise.all([
      Promise.all(
        Array.from({ length: 8 }, () => firstDeployment.reserve('invitation')),
      ),
      Promise.all(
        Array.from({ length: 5 }, () => secondDeployment.reserve('priority')),
      ),
    ]);
    const reservedInvitations = invitations.filter(({ reserved }) => reserved);
    const reservedPriority = priority.filter(({ reserved }) => reserved);
    const reserved = reservedInvitations.length + reservedPriority.length;

    // How many of the thirteen win depends on the order they reach the row: the
    // invitations stop at eight, and priority mail takes what is left of ten. So
    // the split is not asserted, only what holds in every order.
    expect(reserved).toBeLessThanOrEqual(10);
    expect(reserved).toBeGreaterThanOrEqual(8);
    expect(reservedInvitations.length).toBeLessThanOrEqual(8);
    await expect(secondDeployment.usage()).resolves.toEqual({
      used: reserved,
      limit: 10,
    });
  });

  it('lets priority mail take the shared budget first, leaving invitations only what remains under their cap', async () => {
    for (let index = 0; index < 5; index += 1) {
      await secondDeployment.reserve('priority');
    }
    const invitations = [];
    for (let index = 0; index < 8; index += 1) {
      invitations.push(await firstDeployment.reserve('invitation'));
    }

    expect(
      invitations.filter((reservation) => reservation.reserved),
    ).toHaveLength(3);
    await expect(firstDeployment.usage()).resolves.toEqual({
      used: 8,
      limit: 10,
    });
  });

  it('pauses invitations at 80 percent while preserving recovery capacity', async () => {
    const invitations = await Promise.all(
      Array.from({ length: 9 }, () => firstDeployment.reserve('invitation')),
    );

    expect(invitations.filter((result) => result.reserved)).toHaveLength(8);

    const recovery = [
      await secondDeployment.reserve('priority'),
      await secondDeployment.reserve('priority'),
      await secondDeployment.reserve('priority'),
    ];

    expect(recovery.map((result) => result.reserved)).toEqual([
      true,
      true,
      false,
    ]);
    expect((await firstDeployment.reserve('invitation')).reserved).toBe(false);
    await expect(firstDeployment.usage()).resolves.toEqual({
      used: 10,
      limit: 10,
    });
  });

  it('keeps the lowest configured invitation and daily limits across deployments', async () => {
    const lowerBudgetDeployment = new PostgresEmailDailySendBudget(
      () => secondPool,
      emailDailySendBudgetLimits(7),
    );
    await firstDeployment.reserve('priority');
    await lowerBudgetDeployment.reserve('priority');

    const invitations = await Promise.all(
      Array.from({ length: 5 }, () => firstDeployment.reserve('invitation')),
    );

    expect(invitations.filter((result) => result.reserved)).toHaveLength(3);
    expect(await firstDeployment.usage()).toEqual({ used: 5, limit: 7 });
  });

  it('reports an immediately lowered effective limit after reservations exceed it', async () => {
    await Promise.all(
      Array.from({ length: 8 }, () => firstDeployment.reserve('priority')),
    );
    const lowerBudgetDeployment = new PostgresEmailDailySendBudget(
      () => secondPool,
      emailDailySendBudgetLimits(5),
    );

    await expect(lowerBudgetDeployment.reserve('priority')).resolves.toEqual(
      expect.objectContaining({ reserved: false }),
    );
    await expect(lowerBudgetDeployment.usage()).resolves.toEqual({
      used: 8,
      limit: 5,
    });
  });

  it('keeps the current day limit when a deployment raises its configured budget', async () => {
    await firstDeployment.reserve('priority');
    const higherBudgetDeployment = new PostgresEmailDailySendBudget(
      () => secondPool,
      emailDailySendBudgetLimits(20),
    );

    await higherBudgetDeployment.reserve('priority');

    await expect(higherBudgetDeployment.usage()).resolves.toEqual({
      used: 2,
      limit: 10,
    });
  });

  it('starts a new UTC-day budget after midnight', async () => {
    await firstDeployment.reserve('priority');
    await firstPool.query(
      'UPDATE email_daily_send_budgets SET budget_date = budget_date - 1 WHERE id = 1',
    );

    await expect(secondDeployment.reserve('invitation')).resolves.toEqual({
      reserved: true,
    });
    await expect(firstDeployment.usage()).resolves.toEqual({
      used: 1,
      limit: 10,
    });
  });
});
