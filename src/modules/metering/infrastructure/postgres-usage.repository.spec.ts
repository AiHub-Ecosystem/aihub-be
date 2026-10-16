import type { UsageRecord } from '@/modules/metering/application/usage-repository.port';
import { Prisma, type PrismaClient } from '@prisma-client/client';
import {
  PostgresUsageRepository,
  type PrismaMeteringClient,
} from './postgres-usage.repository';

function fakePrisma(
  options: {
    createFails?: Error;
  } = {},
) {
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
    $transaction: runTransaction,
  } as unknown as PrismaClient;
  return {
    client: client as PrismaMeteringClient,
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
  billingBasis: 'response',
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
        billingBasis: record.billingBasis,
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
});
