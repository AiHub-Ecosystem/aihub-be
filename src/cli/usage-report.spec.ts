import type {
  UsageReportOperationDefinition,
  UsageReportRepositoryPort,
  UsageReportSnapshotQuery,
  UsageReportSnapshotRow,
} from '@/modules/metering/application/usage-completeness-report';
import {
  formatUsageReportResult,
  parseUsageReportWindow,
  runUsageReportCommand,
} from './usage-report';

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
    throw new Error('raw database failure');
  }
}

const now = new Date('2026-09-20T13:00:00.000Z');
const from = '2026-09-20T12:00:00.000Z';
const to = '2026-09-20T13:00:00.000Z';
const operations: readonly UsageReportOperationDefinition[] = [
  { operation: 'writing.task1.grade', downstream: 'ai-writing' },
];

describe('usage report CLI boundary', () => {
  it('emits deterministic operation and summary JSONL', async () => {
    const lines: string[] = [];

    await runUsageReportCommand({
      databaseUrl: 'postgres://test',
      from,
      to,
      now,
      operations,
      repository: new FakeUsageReportRepository([
        {
          operation: 'writing.task1.grade',
          successfulCount: 100,
          missingUsageCount: 2,
        },
      ]),
      emit: (line) => lines.push(line),
    });

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        event: 'usage_report_operation',
        window_from: from,
        window_to: to,
        operation: 'writing.task1.grade',
        downstream: 'ai-writing',
        successful_count: 100,
        missing_usage_count: 2,
        incomplete_percent: 2,
        status: 'alert',
      },
      {
        event: 'usage_report_summary',
        window_from: from,
        window_to: to,
        eligible_operations: 1,
        eligible_requests: 100,
        alert_operations: 1,
        status: 'alert',
      },
    ]);
  });

  it('emits one safe failure event for missing configuration', async () => {
    const lines: string[] = [];

    await expect(
      runUsageReportCommand({
        databaseUrl: ' ',
        from,
        to,
        now,
        emit: (line) => lines.push(line),
      }),
    ).rejects.toMatchObject({ code: 'USAGE_REPORT_CONFIGURATION_MISSING' });

    expect(lines).toEqual([
      JSON.stringify({
        event: 'usage_report_failed',
        window_from: from,
        window_to: to,
        status: 'failed',
        error_code: 'USAGE_REPORT_CONFIGURATION_MISSING',
      }),
    ]);
  });

  it('emits no partial success rows when Postgres fails', async () => {
    const lines: string[] = [];

    await expect(
      runUsageReportCommand({
        databaseUrl: 'postgres://test',
        from,
        to,
        now,
        operations,
        repository: new FailingUsageReportRepository(),
        emit: (line) => lines.push(line),
      }),
    ).rejects.toMatchObject({ code: 'USAGE_REPORT_DATABASE_FAILURE' });

    expect(lines).toEqual([
      JSON.stringify({
        event: 'usage_report_failed',
        window_from: from,
        window_to: to,
        status: 'failed',
        error_code: 'USAGE_REPORT_DATABASE_FAILURE',
      }),
    ]);
  });

  it.each([
    ['requires UTC timestamps', '2026-09-20T12:00:00+01:00', to],
    ['rejects a future end', from, '2026-09-20T14:00:00.000Z'],
    ['rejects a reversed window', to, from],
    ['rejects a window outside retention', '2025-08-19T12:00:00.000Z', to],
  ])('rejects invalid windows: %s', async (_label, invalidFrom, invalidTo) => {
    await expect(
      runUsageReportCommand({
        databaseUrl: 'postgres://test',
        from: invalidFrom,
        to: invalidTo,
        now,
        emit: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'USAGE_REPORT_INVALID_WINDOW' });
  });

  it('parses a valid half-open UTC window', () => {
    expect(parseUsageReportWindow(from, to, now)).toEqual({
      from: new Date(from),
      to: new Date(to),
    });
  });

  it('formats the same result identically for reruns', async () => {
    const repository = new FakeUsageReportRepository([
      {
        operation: 'writing.task1.grade',
        successfulCount: 100,
        missingUsageCount: 0,
      },
    ]);
    const input = {
      databaseUrl: 'postgres://test',
      from,
      to,
      now,
      operations,
      repository,
      emit: () => undefined,
    };

    const first = await runUsageReportCommand(input);
    const second = await runUsageReportCommand(input);

    expect(formatUsageReportResult(first)).toEqual(
      formatUsageReportResult(second),
    );
    expect(repository.queries).toHaveLength(2);
  });
});
