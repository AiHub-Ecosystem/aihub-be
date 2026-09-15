import type { UsageRecord } from '../application/usage-repository.port';
import {
  type PostgresMeteringClient,
  PostgresUsageRepository,
} from './postgres-usage.repository';

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
  it('inserts a parameterized record with request-id conflict protection', async () => {
    const client = new FakePostgres();
    client.result = [{ request_id: record.requestId }];
    await new PostgresUsageRepository(client).insert(record);

    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]?.text).toContain(
      'ON CONFLICT (request_id) DO NOTHING',
    );
    expect(client.queries[0]?.text).toContain('RETURNING request_id');
    expect(client.queries[0]?.values).toContain(record.requestId);
    expect(client.queries[0]?.values).toContain(JSON.stringify(record.models));
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
        billable_request_count: '2',
        billable_token_count: '15',
        missing_usage_count: '1',
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
    expect(client.queries[0]?.text).toContain('usage_records');
    expect(client.queries[0]?.values).toEqual([
      'org_acme',
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
      'writing.task1.grade',
    ]);
  });
});
