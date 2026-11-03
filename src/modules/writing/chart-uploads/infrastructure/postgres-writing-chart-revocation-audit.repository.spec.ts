import type { PrismaClient } from '@prisma-client/client';
import { PostgresWritingChartRevocationAuditRepository } from './postgres-writing-chart-revocation-audit.repository';

describe('PostgresWritingChartRevocationAuditRepository', () => {
  it('persists the self-declared source with each operator audit record', async () => {
    const create = jest
      .fn<Promise<void>, [{ data: Record<string, unknown> }]>()
      .mockResolvedValue(undefined);
    const client = {
      writingChartRevocationAudit: { create },
    } as unknown as PrismaClient;
    const repository = new PostgresWritingChartRevocationAuditRepository(
      client,
    );

    await repository.append({
      assetId: 'chart_01J00000000000000000000001',
      actorUserAccountId: 'usr_operator',
      actorSource: 'self_declared_operator',
      occurredAt: new Date('2026-10-19T00:00:00.000Z'),
      phase: 'requested',
      originOutcome: null,
      edgeOutcome: null,
      edgeStatus: null,
    });

    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      actorSource: 'self_declared_operator',
    });
  });

  it('counts expired events with the strict retention cutoff', async () => {
    const query = jest
      .fn<Promise<unknown[]>, [string, ...unknown[]]>()
      .mockResolvedValue([{ count: '3' }]);
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
