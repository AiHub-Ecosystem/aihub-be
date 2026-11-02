import { parseBillingMonth } from '@/modules/metering/application/billing-statement';
import { PostgresBillingStatementRepository } from './postgres-billing-statement.repository';
import type { PrismaMeteringClient } from './prisma-metering.client';

describe('PostgresBillingStatementRepository actor provenance', () => {
  it('reads legacy and self-declared sources from the durable audit rows', async () => {
    const query = jest
      .fn<Promise<unknown[]>, [string, ...unknown[]]>()
      .mockResolvedValueOnce([
        {
          id: 'badj_01J00000000000000000000001',
          organization_id: 'org_acme',
          operation: 'writing.task2.grade',
          requests: -2,
          reason: 'disputed request',
          corrects: { request_ids: ['req_1'] },
          actor: 'ops-alice',
          actor_source: 'self_declared_operator',
          created_at: new Date('2026-11-01T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          organization_id: 'org_acme',
          operation: 'writing.task2.grade',
          billable_requests: 3,
          adjustment_requests: -2,
          total_requests: 1,
          closed_by: 'ops-alice',
          actor_source: 'legacy_unknown',
          closed_at: new Date('2026-11-01T00:00:00.000Z'),
        },
      ]);
    const client = {
      $queryRawUnsafe: query,
    } as unknown as PrismaMeteringClient;
    const repository = new PostgresBillingStatementRepository(client);
    const month = parseBillingMonth('2026-10');

    await expect(
      repository.adjustments(month, undefined),
    ).resolves.toMatchObject([{ actorSource: 'self_declared_operator' }]);
    await expect(repository.closures(month, undefined)).resolves.toMatchObject([
      { actorSource: 'legacy_unknown' },
    ]);
    expect(query.mock.calls[0]?.[0]).toContain('actor_source');
    expect(query.mock.calls[1]?.[0]).toContain('actor_source');
  });

  it('writes self-declared provenance for adjustment and month-close actors', async () => {
    const adjustmentCreateMany = jest.fn().mockResolvedValue({ count: 1 });
    const closureCreateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      billingAdjustment: {
        findUnique: jest.fn().mockResolvedValue(null),
        createMany: adjustmentCreateMany,
      },
      billingMonthClosure: {
        count: jest.fn().mockResolvedValue(0),
        createMany: closureCreateMany,
      },
    };
    const client = {
      $transaction: jest.fn(async (work: (tx: typeof transaction) => unknown) =>
        work(transaction),
      ),
    } as unknown as PrismaMeteringClient;
    const repository = new PostgresBillingStatementRepository(client);
    const month = parseBillingMonth('2026-10');

    await repository.closeMonth(
      month,
      [
        {
          organizationId: 'org_acme',
          operation: 'writing.task2.grade',
          billableRequests: 3,
          backgroundCompletionRequests: 0,
          adjustmentRequests: 0,
          totalRequests: 3,
          quotaUnverified: 0,
          excludedReplays: 0,
          excludedFailures: 0,
          excludedInternal: 0,
          excludedNonProduction: 0,
        },
      ],
      'ops-alice',
    );
    await repository.addAdjustment({
      id: 'badj_01J00000000000000000000001',
      organizationId: 'org_acme',
      month,
      operation: 'writing.task2.grade',
      requests: -1,
      reason: 'disputed request',
      corrects: { requestIds: ['req_1'] },
      actor: 'ops-alice',
    });

    expect(closureCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ actorSource: 'self_declared_operator' }),
      ],
    });
    expect(adjustmentCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ actorSource: 'self_declared_operator' }),
      ],
      skipDuplicates: true,
    });
  });
});
