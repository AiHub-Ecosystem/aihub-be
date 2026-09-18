import type {
  UsageRetentionBatchRequest,
  UsageRetentionPort,
} from '../application/usage-retention';
import {
  PostgresUsageRetentionRepository,
  USAGE_RETENTION_BATCH_SQL,
} from './postgres-usage-retention.repository';
import type {
  PostgresMeteringClient,
  PostgresTransactionClient,
} from './postgres-usage.repository';

class FakeTransaction implements PostgresTransactionClient {
  readonly queries: Array<{
    readonly text: string;
    readonly values: readonly unknown[];
  }> = [];
  rows: readonly unknown[] = [];

  async query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly unknown[]> {
    this.queries.push({ text, values });
    return this.rows;
  }
}

class FakePostgres implements PostgresMeteringClient {
  readonly transactionClient = new FakeTransaction();
  transactionCalls = 0;

  async query(): Promise<readonly unknown[]> {
    return [];
  }

  async transaction<T>(
    callback: (client: PostgresTransactionClient) => Promise<T>,
  ): Promise<T> {
    this.transactionCalls += 1;
    return callback(this.transactionClient);
  }

  async close(): Promise<void> {
    return undefined;
  }
}

describe('PostgresUsageRetentionRepository', () => {
  it('deletes one keyset batch in a transaction and returns its cursor', async () => {
    const client = new FakePostgres();
    client.transactionClient.rows = [
      {
        created_at: new Date('2025-02-01T00:00:00.000Z'),
        request_id: 'req_a',
      },
      {
        created_at: new Date('2025-02-28T00:00:00.000Z'),
        request_id: 'req_b',
      },
    ];
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
    expect(client.transactionCalls).toBe(1);
    expect(client.transactionClient.queries).toEqual([
      {
        text: USAGE_RETENTION_BATCH_SQL,
        values: [request.cutoff, null, null, 1000],
      },
    ]);
    expect(USAGE_RETENTION_BATCH_SQL).toContain('FOR UPDATE SKIP LOCKED');
    expect(USAGE_RETENTION_BATCH_SQL).toContain(
      'ORDER BY created_at, request_id',
    );
    expect(USAGE_RETENTION_BATCH_SQL).toContain('WHERE created_at < $1');
    expect(USAGE_RETENTION_BATCH_SQL).not.toContain('created_at <= $1');
    expect(USAGE_RETENTION_BATCH_SQL).not.toContain('outcome');
  });

  it('passes the previous cursor to the next keyset batch', async () => {
    const client = new FakePostgres();
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

    expect(client.transactionClient.queries[0]?.values).toEqual([
      new Date('2025-03-01T00:00:00.000Z'),
      after.createdAt,
      after.requestId,
      1000,
    ]);
  });
});
