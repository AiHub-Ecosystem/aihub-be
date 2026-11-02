import type { PrismaClient } from '@prisma-client/client';
import { PostgresWritingChartRevocationAuditRepository } from './postgres-writing-chart-revocation-audit.repository';

describe('PostgresWritingChartRevocationAuditRepository', () => {
  it('counts expired events with the strict retention cutoff', async () => {
    const query = jest.fn().mockResolvedValue([{ count: '3' }]);
    const client = {
      $queryRawUnsafe: query,
    } as unknown as PrismaClient;
    const repository = new PostgresWritingChartRevocationAuditRepository(
      client,
    );
    const cutoff = new Date('2024-10-19T02:30:00.000Z');

    await expect(repository.countExpired(cutoff)).resolves.toBe(3);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE occurred_at < $1'),
      cutoff,
    );
  });
});
