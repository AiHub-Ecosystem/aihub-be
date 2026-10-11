import type { UsageRecord } from '@/modules/metering/application/usage-repository.port';
import {
  type PostgresMeteringClient,
  type PostgresTransactionClient,
  PostgresUsageRepository,
} from './postgres-usage.repository';

class FakePostgres implements PostgresMeteringClient {
  readonly queries: (readonly unknown[])[] = [];
  transactionCalls = 0;
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
    this.transactionCalls += 1;
    return callback(this);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const record: UsageRecord = {
  requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  actorId: 'student_123',
  service: 'writing',
  operation: 'writing.task1.grade',
  environment: 'production',
  outcome: 'success',
  httpStatus: 200,
  billableRequests: 1,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  models: [{ provider: 'provider-y', name: 'model-x' }],
  meteringStatus: 'complete',
  totalMs: 100,
  downstreamMs: 80,
  aiProcessingMs: 70,
};

describe('PostgresUsageRepository', () => {
  it('inserts the record in a transaction with its request-id conflict behavior', async () => {
    const client = new FakePostgres();
    client.result = [{ request_id: record.requestId }];
    await new PostgresUsageRepository(client).insert(record);

    expect(client.transactionCalls).toBe(1);
    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]).toContain(record.requestId);
    expect(client.queries[0]).toContain(JSON.stringify(record.models));
  });

  it('surfaces a request-id collision instead of silently accepting it', async () => {
    const client = new FakePostgres();

    await expect(
      new PostgresUsageRepository(client).insert(record),
    ).rejects.toThrow('usage record was not inserted');
  });

  it('maps aggregate counts without exposing SQL rows to callers', async () => {
    const client = new FakePostgres();
    client.result = [
      {
        billable_request_count: 2n,
        billable_token_count: 15n,
        missing_usage_count: 1n,
      },
    ];
    const result = await new PostgresUsageRepository(client).aggregate({
      organizationId: 'org_acme',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-10-01T00:00:00Z'),
      operation: 'writing.task1.grade',
    });

    expect(result).toEqual({
      billableRequestCount: 2,
      billableTokenCount: 15,
      missingUsageCount: 1,
    });
    expect(client.queries[0]).toEqual([
      'org_acme',
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
      'writing.task1.grade',
    ]);
  });
});
