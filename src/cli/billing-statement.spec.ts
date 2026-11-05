import type { BillingStatementRepositoryPort } from '@/modules/metering/public/billing-statement';
import { runBillingStatementCommand } from './billing-statement';

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

const parse = (line: string): unknown => JSON.parse(line);

function repositoryFailingOn(failing: string): BillingStatementRepositoryPort {
  return {
    snapshot: jest.fn(async () => ({
      usage: [usageRow('org_a'), usageRow('org_b'), usageRow('org_c')],
      adjustments: [],
      closures: [],
    })),
    closeMonth: jest.fn(async (_month: unknown, organizationId: string) => {
      if (organizationId === failing) {
        throw new Error('connection terminated: secret-token-xyz');
      }
    }),
  } as unknown as BillingStatementRepositoryPort;
}

async function closeMonth(repository: BillingStatementRepositoryPort) {
  const lines: string[] = [];
  const outcome = await runBillingStatementCommand({
    databaseUrl: 'postgres://unused',
    month: '2026-10',
    closeAs: 'ops-alice',
    repository,
    emit: (line) => lines.push(line),
    now: () => new Date('2026-11-02T00:00:00Z'),
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { lines, outcome };
}

describe('billing:statement --close failing partway (#1618)', () => {
  it('names the closed Organizations and the failed one, and keeps the error code', async () => {
    const { lines, outcome } = await closeMonth(repositoryFailingOn('org_c'));

    expect(outcome).toMatchObject({ code: 'BILLING_DATABASE_FAILURE' });
    expect(lines.map(parse)).toEqual([
      {
        event: 'billing_statement_failed',
        month: '2026-10',
        error_code: 'BILLING_DATABASE_FAILURE',
        closed_organizations: ['org_a', 'org_b'],
        failed_organization: 'org_c',
      },
    ]);
  });

  it('reports no closed Organization when the first one fails', async () => {
    const { lines } = await closeMonth(repositoryFailingOn('org_a'));

    expect(parse(lines[0] ?? '{}')).toMatchObject({
      closed_organizations: [],
      failed_organization: 'org_a',
    });
  });

  it('prints Organization ids only: no database text', async () => {
    const { lines } = await closeMonth(repositoryFailingOn('org_b'));

    expect(lines.join('\n')).not.toMatch(/secret-token-xyz|ops-alice/);
  });

  it('lists the closed Organizations without a failed one when only the re-read fails', async () => {
    const repository = {
      snapshot: jest
        .fn()
        .mockResolvedValueOnce({
          usage: [usageRow('org_a'), usageRow('org_b')],
          adjustments: [],
          closures: [],
        })
        .mockRejectedValueOnce(new Error('connection terminated')),
      closeMonth: jest.fn(async () => undefined),
    } as unknown as BillingStatementRepositoryPort;

    const { lines } = await closeMonth(repository);

    expect(lines.map(parse)).toEqual([
      {
        event: 'billing_statement_failed',
        month: '2026-10',
        error_code: 'BILLING_DATABASE_FAILURE',
        closed_organizations: ['org_a', 'org_b'],
      },
    ]);
  });

  it('leaves a failure before any close unchanged', async () => {
    const lines: string[] = [];

    await expect(
      runBillingStatementCommand({
        databaseUrl: 'postgres://unused',
        month: '2026-13',
        closeAs: 'ops-alice',
        emit: (line) => lines.push(line),
      }),
    ).rejects.toMatchObject({ code: 'BILLING_INVALID_MONTH' });
    expect(lines.map(parse)).toEqual([
      {
        event: 'billing_statement_failed',
        month: '2026-13',
        error_code: 'BILLING_INVALID_MONTH',
      },
    ]);
  });
});
