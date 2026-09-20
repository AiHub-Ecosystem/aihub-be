import {
  PostgresUsageCompletenessReportRepository,
  USAGE_REPORT_SQL,
} from './postgres-usage-completeness-report.repository';
import type { PostgresMeteringClient } from './postgres-usage.repository';

class FakePostgres implements PostgresMeteringClient {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  result: readonly unknown[] = [];

  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]> {
    this.queries.push({ text, values });
    return Promise.resolve(this.result);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('PostgresUsageCompletenessReportRepository', () => {
  it('reads one grouped snapshot with the explicit eligible operation list', async () => {
    const client = new FakePostgres();
    client.result = [
      {
        operation: 'writing.task1.grade',
        successful_count: '100',
        missing_usage_count: '2',
      },
    ];
    const from = new Date('2026-09-20T12:00:00.000Z');
    const to = new Date('2026-09-20T13:00:00.000Z');

    await expect(
      new PostgresUsageCompletenessReportRepository(client).snapshot({
        from,
        to,
        operations: ['writing.task1.grade', 'speaking.grading'],
      }),
    ).resolves.toEqual([
      {
        operation: 'writing.task1.grade',
        successfulCount: 100,
        missingUsageCount: 2,
      },
    ]);

    expect(client.queries).toEqual([
      {
        text: USAGE_REPORT_SQL,
        values: [from, to, ['writing.task1.grade', 'speaking.grading']],
      },
    ]);
    expect(USAGE_REPORT_SQL).toContain("outcome = 'success'");
    expect(USAGE_REPORT_SQL).toContain("metering_status = 'missing_usage'");
    expect(USAGE_REPORT_SQL).toContain('GROUP BY operation');
  });

  it('rejects malformed database counts as an invalid snapshot', async () => {
    const client = new FakePostgres();
    client.result = [
      {
        operation: 'writing.task1.grade',
        successful_count: 'not-a-count',
        missing_usage_count: '0',
      },
    ];

    await expect(
      new PostgresUsageCompletenessReportRepository(client).snapshot({
        from: new Date('2026-09-20T12:00:00.000Z'),
        to: new Date('2026-09-20T13:00:00.000Z'),
        operations: ['writing.task1.grade'],
      }),
    ).rejects.toMatchObject({ code: 'USAGE_REPORT_SNAPSHOT_INVALID' });
  });
});
