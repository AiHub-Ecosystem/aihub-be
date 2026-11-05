import { parseBillingMonth } from '@/modules/metering/application/billing/billing-statement';
import type { PrismaMeteringClient } from '@/modules/metering/infrastructure/usage-recording/prisma-metering.client';
import {
  BILLING_MONTH_LOCK_SQL,
  PostgresBillingStatementRepository,
} from './postgres-billing-statement.repository';

const line = {
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
};

describe('PostgresBillingStatementRepository actor provenance', () => {
  it('reads legacy and self-declared sources from the durable audit rows', async () => {
    const query = jest
      .fn<Promise<unknown[]>, [string, ...unknown[]]>()
      .mockResolvedValueOnce([])
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
      $transaction: jest.fn(
        async (work: (tx: { $queryRawUnsafe: typeof query }) => unknown) =>
          work({ $queryRawUnsafe: query }),
      ),
    } as unknown as PrismaMeteringClient;
    const repository = new PostgresBillingStatementRepository(client);
    const month = parseBillingMonth('2026-10');

    const snapshot = await repository.snapshot(month, undefined);

    expect(snapshot.adjustments).toMatchObject([
      { actorSource: 'self_declared_operator' },
    ]);
    expect(snapshot.closures).toMatchObject([
      { actorSource: 'legacy_unknown' },
    ]);
    expect(query.mock.calls[1]?.[0]).toContain('actor_source');
    expect(query.mock.calls[2]?.[0]).toContain('actor_source');
  });

  it('writes self-declared provenance for adjustment and month-close actors', async () => {
    const adjustmentCreateMany = jest.fn().mockResolvedValue({ count: 1 });
    const closureCreateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
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

    await repository.closeMonth(month, 'org_acme', 'ops-alice', () => [line]);
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

describe('PostgresBillingStatementRepository month lock and snapshot (#999)', () => {
  const month = parseBillingMonth('2026-10');

  function clientWith(events: string[]) {
    const transaction = {
      $executeRawUnsafe: jest.fn(async (sql: string, key: string) => {
        events.push(`lock ${sql === BILLING_MONTH_LOCK_SQL ? key : sql}`);
        return 1;
      }),
      $queryRawUnsafe: jest.fn(async () => {
        events.push('read');
        return [];
      }),
      billingAdjustment: {
        findUnique: jest.fn(async () => {
          events.push('find');
          return null;
        }),
        createMany: jest.fn(async () => {
          events.push('insert');
          return { count: 1 };
        }),
      },
      billingMonthClosure: {
        count: jest.fn(async () => {
          events.push('closed?');
          return 0;
        }),
        createMany: jest.fn(async () => {
          events.push('closure');
          return { count: 1 };
        }),
      },
    };
    const $transaction = jest.fn(
      async (work: (tx: typeof transaction) => unknown, _options?: unknown) =>
        work(transaction),
    );
    return {
      $transaction,
      repository: new PostgresBillingStatementRepository({
        $transaction,
      } as unknown as PrismaMeteringClient),
    };
  }

  it('reads a statement in one REPEATABLE READ transaction', async () => {
    const events: string[] = [];
    const { repository, $transaction } = clientWith(events);

    await repository.snapshot(month, 'org_acme');

    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0]?.[1]).toMatchObject({
      isolationLevel: 'RepeatableRead',
    });
    expect(events).toEqual(['read', 'read', 'read']);
  });

  it('closes a month under the month lock, before reading and until it writes', async () => {
    const events: string[] = [];
    const { repository, $transaction } = clientWith(events);

    await repository.closeMonth(month, 'org_acme', 'ops-alice', () => {
      events.push('decide');
      return [line];
    });

    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0]?.[1]).toMatchObject({
      isolationLevel: 'ReadCommitted',
    });
    expect(events).toEqual([
      'lock org_acme:billing-month:2026-10',
      'read',
      'read',
      'read',
      'decide',
      'closure',
    ]);
  });

  it('writes nothing when the Organization is already closed', async () => {
    const events: string[] = [];
    const { repository } = clientWith(events);

    await repository.closeMonth(month, 'org_acme', 'ops-alice', () => []);

    expect(events).not.toContain('closure');
  });

  it('adjusts under the same month lock, across its closed-month check and insert', async () => {
    const events: string[] = [];
    const { repository, $transaction } = clientWith(events);

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

    expect($transaction.mock.calls[0]?.[1]).toMatchObject({
      isolationLevel: 'ReadCommitted',
    });
    expect(events).toEqual([
      'lock org_acme:billing-month:2026-10',
      'find',
      'closed?',
      'insert',
    ]);
  });
});
