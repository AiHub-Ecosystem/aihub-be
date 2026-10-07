import type {
  UsageReportRepositoryPort,
  UsageReportSnapshotQuery,
  UsageReportSnapshotRow,
} from './usage-completeness-report';
import {
  UsageCompletenessReportService,
  UsageReportDatabaseError,
  type UsageReportOperationDefinition,
  UsageReportSnapshotError,
  usageReportOperations,
} from './usage-completeness-report';

class FakeUsageReportRepository implements UsageReportRepositoryPort {
  readonly queries: UsageReportSnapshotQuery[] = [];

  constructor(private readonly rows: readonly UsageReportSnapshotRow[]) {}

  async snapshot(
    query: UsageReportSnapshotQuery,
  ): Promise<readonly UsageReportSnapshotRow[]> {
    this.queries.push(query);
    return this.rows;
  }
}

class FailingUsageReportRepository implements UsageReportRepositoryPort {
  async snapshot(): Promise<readonly UsageReportSnapshotRow[]> {
    throw new Error('database details must not cross the port');
  }
}

const operations: readonly UsageReportOperationDefinition[] = [
  { operation: 'writing.task1.grade', downstream: 'ai-writing' },
];

describe('UsageCompletenessReportService', () => {
  it('reports a complete operation as healthy', async () => {
    const repository = new FakeUsageReportRepository([
      {
        operation: 'writing.task1.grade',
        successfulCount: 100,
        missingUsageCount: 0,
      },
    ]);
    const window = {
      from: new Date('2026-09-20T12:00:00.000Z'),
      to: new Date('2026-09-20T13:00:00.000Z'),
    };

    await expect(
      new UsageCompletenessReportService(repository, operations).report(window),
    ).resolves.toEqual({
      window,
      operations: [
        {
          operation: 'writing.task1.grade',
          downstream: 'ai-writing',
          successfulCount: 100,
          missingUsageCount: 0,
          incompletePercent: 0,
          status: 'healthy',
        },
      ],
      summary: {
        eligibleOperations: 1,
        eligibleRequests: 100,
        alertOperations: 0,
        status: 'healthy',
      },
    });
    expect(repository.queries).toEqual([
      {
        ...window,
        operations: ['writing.task1.grade'],
      },
    ]);
  });

  it('emits zero-count rows, sorts operations, and alerts strictly above one percent', async () => {
    const repository = new FakeUsageReportRepository([
      {
        operation: 'speaking.grading',
        successfulCount: 100,
        missingUsageCount: 2,
      },
    ]);
    const definitions: readonly UsageReportOperationDefinition[] = [
      { operation: 'speaking.grading', downstream: 'ai-speaking' },
      { operation: 'writing.task1.grade', downstream: 'ai-writing' },
    ];

    const result = await new UsageCompletenessReportService(
      repository,
      definitions,
    ).report({
      from: new Date('2026-09-20T12:00:00.000Z'),
      to: new Date('2026-09-20T13:00:00.000Z'),
    });

    expect(result.operations).toEqual([
      {
        operation: 'speaking.grading',
        downstream: 'ai-speaking',
        successfulCount: 100,
        missingUsageCount: 2,
        incompletePercent: 2,
        status: 'alert',
      },
      {
        operation: 'writing.task1.grade',
        downstream: 'ai-writing',
        successfulCount: 0,
        missingUsageCount: 0,
        incompletePercent: 0,
        status: 'healthy',
      },
    ]);
    expect(result.summary).toEqual({
      eligibleOperations: 2,
      eligibleRequests: 100,
      alertOperations: 1,
      status: 'alert',
    });
  });

  it('keeps an exactly one percent rate healthy and rounds display values', async () => {
    const repository = new FakeUsageReportRepository([
      {
        operation: 'writing.task1.grade',
        successfulCount: 100,
        missingUsageCount: 1,
      },
    ]);

    const result = await new UsageCompletenessReportService(
      repository,
      operations,
    ).report({
      from: new Date('2026-09-20T12:00:00.000Z'),
      to: new Date('2026-09-20T13:00:00.000Z'),
    });

    expect(result.operations[0]).toMatchObject({
      incompletePercent: 1,
      status: 'healthy',
    });
    expect(result.summary.status).toBe('healthy');
  });

  it('maps a repository failure to a safe report error', async () => {
    await expect(
      new UsageCompletenessReportService(
        new FailingUsageReportRepository(),
        operations,
      ).report({
        from: new Date('2026-09-20T12:00:00.000Z'),
        to: new Date('2026-09-20T13:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(UsageReportDatabaseError);
  });

  it('rejects an invalid snapshot without emitting a partial result', async () => {
    const repository = new FakeUsageReportRepository([
      {
        operation: 'writing.task1.grade',
        successfulCount: 1,
        missingUsageCount: 2,
      },
    ]);

    await expect(
      new UsageCompletenessReportService(repository, operations).report({
        from: new Date('2026-09-20T12:00:00.000Z'),
        to: new Date('2026-09-20T13:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(UsageReportSnapshotError);
  });

  it('keeps enabled AI Speaking operations healthy with zero eligible requests', async () => {
    const repository = new FakeUsageReportRepository([]);
    const result = await new UsageCompletenessReportService(
      repository,
      usageReportOperations(),
    ).report({
      from: new Date('2026-09-20T12:00:00.000Z'),
      to: new Date('2026-09-20T13:00:00.000Z'),
    });

    expect(result).toEqual({
      window: {
        from: new Date('2026-09-20T12:00:00.000Z'),
        to: new Date('2026-09-20T13:00:00.000Z'),
      },
      operations: [
        {
          operation: 'speaking.grading',
          downstream: 'ai-speaking',
          successfulCount: 0,
          missingUsageCount: 0,
          incompletePercent: 0,
          status: 'healthy',
        },
        {
          operation: 'speaking.grading-json',
          downstream: 'ai-speaking',
          successfulCount: 0,
          missingUsageCount: 0,
          incompletePercent: 0,
          status: 'healthy',
        },
      ],
      summary: {
        eligibleOperations: 2,
        eligibleRequests: 0,
        alertOperations: 0,
        status: 'healthy',
      },
    });
    expect(repository.queries[0]?.operations).toEqual([
      'speaking.grading',
      'speaking.grading-json',
    ]);
  });
});
