import {
  type BillingStatementRepositoryPort,
  BillingStatementService,
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
          closedAt: new Date(0),
        },
        {
          organizationId: 'org_a',
          operation: 'writing.task1.grade',
          billableRequests: 2,
          adjustmentRequests: 0,
          totalRequests: 2,
          closedBy: 'op',
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

describe('BillingStatementService.adjust', () => {
  const repository = {
    addAdjustment: jest.fn(async () => 'created' as const),
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
});
