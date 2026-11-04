import type { PrismaClient } from '@prisma-client/client';
import { PostgresQuotaReconciliationRepository } from './postgres-quota-reconciliation.repository';

function fakePrisma(rows: readonly unknown[] = []) {
  const query = jest.fn().mockResolvedValue(rows);
  return {
    client: { $queryRawUnsafe: query } as unknown as PrismaClient,
    query,
  };
}

describe('PostgresQuotaReconciliationRepository', () => {
  it('maps quota-bearing organizations for the requested UTC window', async () => {
    const { client, query } = fakePrisma([
      {
        organization_id: 'org_zulu',
        quota: 2,
        billable_count: 3n,
      },
      {
        organization_id: 'org_alpha',
        quota: 10,
        billable_count: 0n,
      },
    ]);
    const repository = new PostgresQuotaReconciliationRepository(client);
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-10-01T00:00:00.000Z');

    await expect(
      repository.list({ month: '2026-09', from, to }),
    ).resolves.toEqual([
      {
        organizationId: 'org_alpha',
        monthlyRequestQuota: 10,
        billableRequestCount: 0,
      },
      {
        organizationId: 'org_zulu',
        monthlyRequestQuota: 2,
        billableRequestCount: 3,
      },
    ]);
    expect(query).toHaveBeenCalledWith(expect.any(String), from, to);
  });

  it('rejects an unsafe aggregate before any application write can occur', async () => {
    const { client } = fakePrisma([
      {
        organization_id: 'org_alpha',
        quota: 10,
        billable_count: 9007199254740992n,
      },
    ]);
    const repository = new PostgresQuotaReconciliationRepository(client);

    await expect(
      repository.list({
        month: '2026-09',
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow('quota reconciliation field billable_count is invalid');
  });
});
