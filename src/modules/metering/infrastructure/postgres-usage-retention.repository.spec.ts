import type {
  UsageRetentionBatchRequest,
  UsageRetentionPort,
} from '@/modules/metering/application/usage-retention';
import type { Prisma, PrismaClient } from '@prisma-client/client';
import { PostgresUsageRetentionRepository } from './postgres-usage-retention.repository';

function fakePrisma(rows: readonly unknown[] = []) {
  const query = jest.fn().mockResolvedValue(rows);
  const transaction = {
    $queryRawUnsafe: query,
  } as unknown as Prisma.TransactionClient;
  const runTransaction = jest.fn(
    async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(transaction),
  );
  const client = {
    $queryRawUnsafe: query,
    $transaction: runTransaction,
  } as unknown as PrismaClient;
  return { client, query, runTransaction, transaction };
}

describe('PostgresUsageRetentionRepository', () => {
  it('uses a strict cutoff and skip-locked keyset batch in a transaction', async () => {
    const { client, query, runTransaction } = fakePrisma([
      {
        created_at: new Date('2025-02-01T00:00:00.000Z'),
        request_id: 'req_a',
      },
      {
        created_at: new Date('2025-02-28T00:00:00.000Z'),
        request_id: 'req_b',
      },
    ]);
    const repository: UsageRetentionPort = new PostgresUsageRetentionRepository(
      client,
    );
    const request: UsageRetentionBatchRequest = {
      cutoff: new Date('2025-03-01T00:00:00.000Z'),
      batchSize: 1000,
    };

    await expect(repository.pruneBatch(request)).resolves.toEqual({
      deleted: 2,
      nextCursor: {
        createdAt: new Date('2025-02-28T00:00:00.000Z'),
        requestId: 'req_b',
      },
    });
    expect(runTransaction.mock.calls).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(
      expect.any(String),
      request.cutoff,
      null,
      null,
      1000,
    );
  });

  it('passes the previous cursor to the next keyset batch', async () => {
    const { client, query } = fakePrisma();
    const repository = new PostgresUsageRetentionRepository(client);
    const after = {
      createdAt: new Date('2025-01-31T00:00:00.000Z'),
      requestId: 'req_previous',
    };

    await repository.pruneBatch({
      cutoff: new Date('2025-03-01T00:00:00.000Z'),
      batchSize: 1000,
      after,
    });

    expect(query).toHaveBeenCalledWith(
      expect.any(String),
      new Date('2025-03-01T00:00:00.000Z'),
      after.createdAt,
      after.requestId,
      1000,
    );
  });

  it('prunes dispatch evidence in bounded strict-cutoff batches', async () => {
    const { client, query } = fakePrisma([{ attempt_id: 'expired-attempt' }]);
    const repository = new PostgresUsageRetentionRepository(client);
    const cutoff = new Date('2025-03-01T00:00:00.000Z');

    await expect(repository.pruneDispatchAttempts(cutoff, 1000)).resolves.toBe(
      1,
    );

    expect(query).toHaveBeenCalledWith(expect.any(String), cutoff, 1000);
  });
});
