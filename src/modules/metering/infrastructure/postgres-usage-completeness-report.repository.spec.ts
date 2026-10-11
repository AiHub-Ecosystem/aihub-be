import { PostgresUsageCompletenessReportRepository } from './postgres-usage-completeness-report.repository';
import type {
  PostgresMeteringClient,
  PostgresTransactionClient,
} from './postgres-usage.repository';

class FakePostgres implements PostgresMeteringClient {
  readonly queries: (readonly unknown[])[] = [];
  result: readonly unknown[] = [];

  async query<Row extends object = Record<string, unknown>>(
    _text: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    this.queries.push(values);
    return this.result as readonly Row[];
  }

  async transaction<T>(
    callback: (client: PostgresTransactionClient) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('PostgresUsageCompletenessReportRepository', () => {
  it('maps one grouped snapshot for the explicit eligible operation list', async () => {
    const client = new FakePostgres();
    client.result = [
      {
        operation: 'writing.task1.grade',
        successful_count: 100n,
        missing_usage_count: 2n,
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
      [from, to, ['writing.task1.grade', 'speaking.grading']],
    ]);
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
