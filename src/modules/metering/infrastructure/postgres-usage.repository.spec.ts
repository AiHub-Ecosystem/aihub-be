import type { UsageRecord } from '@/modules/metering/application/usage-repository.port';
import { Prisma, type PrismaClient } from '@prisma-client/client';
import {
  PostgresUsageRepository,
  type PrismaMeteringClient,
} from './postgres-usage.repository';

function fakePrisma(
  options: {
    aggregateRows?: readonly unknown[];
    createFails?: Error;
  } = {},
) {
  const raw = jest.fn().mockResolvedValue(options.aggregateRows ?? []);
  const create = jest.fn(async (_args: unknown) => {
    if (options.createFails !== undefined) {
      throw options.createFails;
    }
    return {};
  });
  const transaction = {
    usageRecord: { create },
  } as unknown as Prisma.TransactionClient;
  const runTransaction = jest.fn(
    async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(transaction),
  );
  const client = {
    $queryRawUnsafe: raw,
    $transaction: runTransaction,
  } as unknown as PrismaClient;
  return {
    client: client as PrismaMeteringClient,
    raw,
    create,
    runTransaction,
  };
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
  it('inserts the record in a transaction', async () => {
    const { client, create, runTransaction } = fakePrisma();
    await new PostgresUsageRepository(client).insert(record);

    expect(runTransaction.mock.calls).toHaveLength(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        requestId: record.requestId,
        organizationId: record.organizationId,
        apiKeyId: record.apiKeyId,
        actorId: record.actorId,
        service: record.service,
        operation: record.operation,
        environment: record.environment,
        outcome: record.outcome,
        httpStatus: record.httpStatus,
        errorCode: null,
        billableRequests: record.billableRequests,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        models: [{ provider: 'provider-y', name: 'model-x' }],
        meteringStatus: record.meteringStatus,
        totalMs: record.totalMs,
        downstreamMs: record.downstreamMs,
        aiProcessingMs: record.aiProcessingMs,
      },
    });
  });

  it('stores an absent model list as SQL NULL, not a JSON null', async () => {
    const { client, create } = fakePrisma();
    const { models: _models, ...withoutModels } = record;
    await new PostgresUsageRepository(client).insert(withoutModels);

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: { models: Prisma.DbNull },
    });
  });

  it('surfaces a request-id collision instead of silently accepting it', async () => {
    const collision = new Error('Unique constraint failed on request_id');
    const { client } = fakePrisma({ createFails: collision });

    await expect(
      new PostgresUsageRepository(client).insert(record),
    ).rejects.toBe(collision);
  });

  it('maps aggregate counts without exposing SQL rows to callers', async () => {
    const { client, raw } = fakePrisma({
      aggregateRows: [
        {
          billable_request_count: 2n,
          billable_token_count: 15n,
          missing_usage_count: 1n,
        },
      ],
    });
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
