import {
  type BillingStatementRepositoryPort,
  BillingStatementService,
  type NewBillingAdjustment,
  buildBillingStatement,
  parseBillingMonth,
} from './billing-statement';

const OCTOBER = parseBillingMonth('2026-10');

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw');
}

describe('parseBillingMonth', () => {
  it('bounds a UTC month on both sides', () => {
    expect(OCTOBER).toEqual({
      label: '2026-10',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(parseBillingMonth('2026-12').to).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    );
  });

  it.each(['2026-13', '2026-1', '10-2026', ''])('refuses %p', (raw) => {
    expect(captureError(() => parseBillingMonth(raw))).toMatchObject({
      code: 'BILLING_INVALID_MONTH',
    });
  });

  it('trims its input', () => {
    expect(parseBillingMonth('  2026-10  ').label).toBe('2026-10');
  });
});

describe('buildBillingStatement', () => {
  it('reports only the operations whose closed total no longer matches', () => {
    const statement = buildBillingStatement(
      OCTOBER,
      [
        {
          organizationId: 'org_a',
          operation: 'writing.task2.grade',
          billableResponses: 4,
          billableBackgroundCompletions: 1,
          quotaUnverified: 0,
          excludedReplays: 0,
          excludedFailures: 0,
          excludedInternal: 0,
          excludedNonProduction: 0,
        },
      ],
      [],
      [
        {
          organizationId: 'org_a',
          operation: 'writing.task2.grade',
          billableRequests: 5,
          adjustmentRequests: 0,
          totalRequests: 5,
          closedBy: 'op',
          actorSource: 'legacy_unknown',
          closedAt: new Date(0),
        },
        {
          organizationId: 'org_a',
          operation: 'writing.task1.grade',
          billableRequests: 2,
          adjustmentRequests: 0,
          totalRequests: 2,
          closedBy: 'op',
          actorSource: 'legacy_unknown',
          closedAt: new Date(0),
        },
      ],
    );

    expect(statement.differences).toEqual([
      {
        organizationId: 'org_a',
        operation: 'writing.task1.grade',
        closedTotal: 2,
        currentTotal: 0,
      },
    ]);
  });
});

describe('BillingStatementService.statement close', () => {
  const usageRow = (organizationId: string) => ({
    organizationId,
    operation: 'writing.task2.grade',
    billableResponses: 2,
    billableBackgroundCompletions: 0,
    quotaUnverified: 0,
    excludedReplays: 0,
    excludedFailures: 0,
    excludedInternal: 0,
    excludedNonProduction: 0,
  });
  const closure = (organizationId: string) => ({
    organizationId,
    operation: 'writing.task2.grade',
    billableRequests: 2,
    adjustmentRequests: 0,
    totalRequests: 2,
    closedBy: 'op',
    actorSource: 'legacy_unknown' as const,
    closedAt: new Date(0),
  });
  const now = new Date('2026-11-02T00:00:00Z');

  it('closes each open Organization once and skips a closed one', async () => {
    const closeMonth = jest.fn(
      async (
        _month: unknown,
        _organizationId: string,
        _actor: string,
        _decide: unknown,
      ) => undefined,
    );
    const repository = {
      snapshot: jest.fn(async () => ({
        usage: [usageRow('org_a'), usageRow('org_b')],
        adjustments: [],
        closures: [closure('org_a')],
      })),
      closeMonth,
    } as unknown as BillingStatementRepositoryPort;

    await new BillingStatementService(repository).statement({
      month: OCTOBER,
      closeAs: 'op',
      now,
    });

    expect(closeMonth.mock.calls.map((call) => call[1])).toEqual(['org_b']);
  });

  it('decides on the locked snapshot: lines to store unless a closure exists', async () => {
    const closeMonth = jest.fn(
      async (
        _month: unknown,
        _organizationId: string,
        _actor: string,
        _decide: (snapshot: {
          usage: unknown[];
          adjustments: unknown[];
          closures: unknown[];
        }) => readonly unknown[],
      ) => undefined,
    );
    const repository = {
      snapshot: jest.fn(async () => ({
        usage: [usageRow('org_b')],
        adjustments: [],
        closures: [],
      })),
      closeMonth,
    } as unknown as BillingStatementRepositoryPort;
    await new BillingStatementService(repository).statement({
      month: OCTOBER,
      closeAs: 'op',
      now,
    });
    const decide = closeMonth.mock.calls[0]?.[3];

    expect(
      decide?.({ usage: [usageRow('org_b')], adjustments: [], closures: [] }),
    ).toMatchObject([{ organizationId: 'org_b', totalRequests: 2 }]);
    expect(
      decide?.({
        usage: [usageRow('org_b')],
        adjustments: [],
        closures: [closure('org_b')],
      }),
    ).toEqual([]);
  });

  it('refuses to close a month that has not ended', async () => {
    await expect(
      new BillingStatementService(
        {} as BillingStatementRepositoryPort,
      ).statement({
        month: OCTOBER,
        closeAs: 'op',
        now: new Date('2026-10-31T23:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'BILLING_MONTH_NOT_ENDED' });
  });
});

describe('BillingStatementService.adjust', () => {
  const repository = {
    addAdjustment: jest.fn(async (adjustment: NewBillingAdjustment) => ({
      status: 'created' as const,
      adjustment,
    })),
  } as unknown as BillingStatementRepositoryPort;
  const valid = {
    id: 'badj_01J00000000000000000000001',
    organizationId: 'org_a',
    month: OCTOBER,
    operation: 'writing.task2.grade',
    requests: -2,
    reason: 'disputed',
    corrects: { requestIds: ['req_1'] },
    actor: 'op',
  };

  it.each([
    ['an invalid adjustment id', { id: 'badj_invalid' }],
    ['a zero count', { requests: 0 }],
    ['a fractional count', { requests: 1.5 }],
    ['no reason', { reason: ' ' }],
    ['no request ids', { corrects: { requestIds: [] } }],
    [
      'an empty period',
      { corrects: { period: { from: '2026-10-02', to: '2026-10-02' } } },
    ],
  ])('refuses %s', async (_label, change) => {
    await expect(
      new BillingStatementService(repository).adjust({ ...valid, ...change }),
    ).rejects.toMatchObject({ code: 'BILLING_INVALID_ADJUSTMENT' });
  });

  it('returns reused for an identical durable adjustment', async () => {
    const reusedRepository = {
      addAdjustment: jest.fn(async (adjustment: NewBillingAdjustment) => ({
        status: 'existing' as const,
        adjustment,
      })),
    } as unknown as BillingStatementRepositoryPort;

    await expect(
      new BillingStatementService(reusedRepository).adjust(valid),
    ).resolves.toBe('reused');
  });

  it('refuses a different payload under an existing adjustment id', async () => {
    const reusedRepository = {
      addAdjustment: jest.fn(async () => ({
        status: 'existing' as const,
        adjustment: valid,
      })),
    } as unknown as BillingStatementRepositoryPort;

    await expect(
      new BillingStatementService(reusedRepository).adjust({
        ...valid,
        requests: -3,
      }),
    ).rejects.toMatchObject({
      code: 'BILLING_INVALID_ADJUSTMENT',
      message: 'adjustment id was reused with different values',
    });
  });
});
