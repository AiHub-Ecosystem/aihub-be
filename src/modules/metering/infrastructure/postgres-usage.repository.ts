import type {
  UsageRecord,
  UsageRepositoryPort,
} from '@/modules/metering/application/usage-repository.port';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { Prisma } from '@prisma-client/client';
import type { PrismaMeteringClient } from './prisma-metering.client';

export { createPostgresMeteringClient } from './postgres-metering.fixture-client';
export type { PrismaMeteringClient } from './prisma-metering.client';

export class PostgresUsageRepository implements UsageRepositoryPort {
  constructor(private readonly client: PrismaMeteringClient) {}

  async insert(record: UsageRecord): Promise<void> {
    // A request id that is already recorded is a collision to surface, not to
    // accept: the unique key makes this throw rather than overwrite.
    await this.client.$transaction(async (transaction) => {
      await transaction.usageRecord.create({
        data: {
          requestId: record.requestId,
          organizationId: record.organizationId,
          apiKeyId: record.apiKeyId,
          actorId: record.actorId ?? null,
          service: record.service,
          operation: record.operation,
          environment: record.environment,
          outcome: record.outcome,
          httpStatus: record.httpStatus,
          errorCode: record.errorCode ?? null,
          billableRequests: record.billableRequests,
          inputTokens: record.usage?.inputTokens ?? null,
          outputTokens: record.usage?.outputTokens ?? null,
          totalTokens: record.usage?.totalTokens ?? null,
          models:
            record.models === undefined
              ? Prisma.DbNull
              : record.models.map(({ provider, name }) => ({ provider, name })),
          meteringStatus: record.meteringStatus,
          totalMs: record.totalMs,
          downstreamMs: record.downstreamMs ?? null,
          aiProcessingMs: record.aiProcessingMs ?? null,
          billingBasis: record.billingBasis,
        },
      });
    }, CONTROL_PLANE_TRANSACTION_OPTIONS);
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
