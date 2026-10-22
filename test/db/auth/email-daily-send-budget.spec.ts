import { PostgresEmailDailySendBudget } from '@/modules/auth/email-delivery/infrastructure/postgres-email-daily-send-budget';
import { createTestPool, resetIdentityTables } from '../shared/database';

describe('shared durable Resend daily budget', () => {
  const firstPool = createTestPool();
  const secondPool = createTestPool();
  const firstDeployment = new PostgresEmailDailySendBudget(() => firstPool, 10);
  const secondDeployment = new PostgresEmailDailySendBudget(
    () => secondPool,
    10,
  );

  beforeEach(async () => {
    await resetIdentityTables(firstPool);
  });

  afterAll(async () => {
    await Promise.all([firstPool.end(), secondPool.end()]);
  });

  it('shares one atomic daily budget across independent deployment connections', async () => {
    const reservations = await Promise.all([
      ...Array.from({ length: 8 }, () =>
        firstDeployment.reserve('organization_invite_email'),
      ),
      ...Array.from({ length: 5 }, () =>
        secondDeployment.reserve('password_reset_email'),
      ),
    ]);

    expect(
      reservations.filter((reservation) => reservation.reserved),
    ).toHaveLength(10);
    expect(
      reservations.filter((reservation) => !reservation.reserved),
    ).toHaveLength(3);
    await expect(secondDeployment.usage()).resolves.toEqual({
      used: 10,
      limit: 10,
    });
  });

  it('pauses invitations at 80 percent while preserving recovery capacity', async () => {
    const invitations = await Promise.all(
      Array.from({ length: 9 }, () =>
        firstDeployment.reserve('organization_invite_email'),
      ),
    );

    expect(invitations.filter((result) => result.reserved)).toHaveLength(8);

    const recovery = [
      await secondDeployment.reserve('verification_email'),
      await secondDeployment.reserve('password_reset_email'),
      await secondDeployment.reserve('password_reset_email'),
    ];

    expect(recovery.map((result) => result.reserved)).toEqual([
      true,
      true,
      false,
    ]);
    expect(
      (await firstDeployment.reserve('organization_invite_email')).reserved,
    ).toBe(false);
    await expect(firstDeployment.usage()).resolves.toEqual({
      used: 10,
      limit: 10,
    });
  });

  it('starts a new UTC-day budget after midnight', async () => {
    await firstDeployment.reserve('password_reset_email');
    await firstPool.query(
      'UPDATE email_daily_send_budgets SET budget_date = budget_date - 1 WHERE id = 1',
    );

    await expect(
      secondDeployment.reserve('organization_invite_email'),
    ).resolves.toEqual({ reserved: true });
    await expect(firstDeployment.usage()).resolves.toEqual({
      used: 1,
      limit: 10,
    });
  });
});
