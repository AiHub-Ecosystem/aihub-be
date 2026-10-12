import type { PrismaClient } from '@prisma-client/client';
import { PostgresUsageCompletenessReportRepository } from './postgres-usage-completeness-report.repository';

function fakePrisma(rows: readonly unknown[] = []) {
  const query = jest.fn().mockResolvedValue(rows);
  return {
    client: { $queryRawUnsafe: query } as unknown as PrismaClient,
    query,
  };
}

describe('PostgresUsageCompletenessReportRepository', () => {
  it('maps one grouped snapshot for the explicit eligible operation list', async () => {
    const { client, query } = fakePrisma([
      {
        operation: 'writing.task1.grade',
        successful_count: 100n,
        missing_usage_count: 2n,
      },
    ]);
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

    expect(query).toHaveBeenCalledWith(expect.any(String), from, to, [
      'writing.task1.grade',
      'speaking.grading',
    ]);
  });

  it('rejects malformed database counts as an invalid snapshot', async () => {
    const { client } = fakePrisma([
      {
        operation: 'writing.task1.grade',
        successful_count: 'not-a-count',
        missing_usage_count: '0',
      },
    ]);

    await expect(
      new PostgresUsageCompletenessReportRepository(client).snapshot({
        from: new Date('2026-09-20T12:00:00.000Z'),
        to: new Date('2026-09-20T13:00:00.000Z'),
        operations: ['writing.task1.grade'],
      }),
    ).rejects.toMatchObject({ code: 'USAGE_REPORT_SNAPSHOT_INVALID' });
  });
});
