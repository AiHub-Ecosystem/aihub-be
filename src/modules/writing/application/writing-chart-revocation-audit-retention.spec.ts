import { WritingChartRevocationAuditRetentionService } from './writing-chart-revocation-audit-retention';
import type { WritingChartRevocationAuditRepositoryPort } from './writing-chart-revocation.port';

describe('WritingChartRevocationAuditRetentionService', () => {
  it('keeps the exact 24-month cutoff and prunes in bounded batches', async () => {
    const now = new Date('2026-10-19T12:00:00.000Z');
    const pruneExpired = jest
      .fn<Promise<number>, [Date, number]>()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const repository: WritingChartRevocationAuditRepositoryPort = {
      findActiveOperatorAccount: jest.fn(),
      requestRevocation: jest.fn(),
      append: jest.fn(),
      pruneExpired,
    };
    const service = new WritingChartRevocationAuditRetentionService(
      repository,
      () => now,
      2,
    );

    await expect(service.prune()).resolves.toEqual({
      cutoff: new Date('2024-10-19T12:00:00.000Z'),
      batches: 2,
      deleted: 3,
    });
    expect(pruneExpired).toHaveBeenNthCalledWith(
      1,
      new Date('2024-10-19T12:00:00.000Z'),
      2,
    );
    expect(pruneExpired).toHaveBeenNthCalledWith(
      3,
      new Date('2024-10-19T12:00:00.000Z'),
      2,
    );
  });

  it('clamps leap-day cutoffs to the last day of the target month', async () => {
    const repository: WritingChartRevocationAuditRepositoryPort = {
      findActiveOperatorAccount: jest.fn(),
      requestRevocation: jest.fn(),
      append: jest.fn(),
      pruneExpired: jest.fn().mockResolvedValue(0),
    };
    const service = new WritingChartRevocationAuditRetentionService(
      repository,
      () => new Date('2024-02-29T00:00:00.000Z'),
    );

    await expect(service.prune()).resolves.toMatchObject({
      cutoff: new Date('2022-02-28T00:00:00.000Z'),
      deleted: 0,
    });
  });
});
