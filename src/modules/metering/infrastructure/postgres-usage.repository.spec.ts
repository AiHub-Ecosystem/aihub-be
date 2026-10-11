import type { UsageRecord } from '@/modules/metering/application/usage-repository.port';
import type { Prisma, PrismaClient } from '@prisma-client/client';
import {
  PostgresUsageRepository,
  type PrismaMeteringClient,
} from './postgres-usage.repository';

function fakePrisma(rows: readonly unknown[] = []) {
  const raw = jest.fn().mockResolvedValue(rows);
  const transaction = {
    $queryRawUnsafe: raw,
  } as unknown as Prisma.TransactionClient;
  const client = {
    $queryRawUnsafe: raw,
    $transaction: jest.fn(
      async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(transaction),
    ),
  } as unknown as PrismaClient;
  return { client: client as PrismaMeteringClient, raw };
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
    const { client, raw } = fakePrisma([{ request_id: record.requestId }]);
    await new PostgresUsageRepository(client).insert(record);

    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledWith(
      expect.any(String),
      record.requestId,
      record.organizationId,
      record.apiKeyId,
      record.actorId ?? null,
      record.service,
      record.operation,
      record.environment,
      record.outcome,
      record.httpStatus,
      record.errorCode ?? null,
      record.billableRequests,
      record.usage?.inputTokens ?? null,
      record.usage?.outputTokens ?? null,
      record.usage?.totalTokens ?? null,
      JSON.stringify(record.models),
      record.meteringStatus,
      record.totalMs,
      record.downstreamMs ?? null,
      record.aiProcessingMs ?? null,
    );
  });

  it('surfaces a request-id collision instead of silently accepting it', async () => {
    const { client } = fakePrisma([]);

    await expect(
      new PostgresUsageRepository(client).insert(record),
    ).rejects.toThrow('usage record was not inserted');
  });

  it('maps aggregate counts without exposing SQL rows to callers', async () => {
    const { client, raw } = fakePrisma([
      {
        billable_request_count: 2n,
        billable_token_count: 15n,
        missing_usage_count: 1n,
      },
    ]);
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
    expect(raw).toHaveBeenCalledWith(
      expect.any(String),
      'org_acme',
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
      'writing.task1.grade',
    );
  });
});
