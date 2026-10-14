import type {
  UsageAggregate,
  UsageAggregateQuery,
  UsageRecord,
  UsageRepositoryPort,
} from '@/modules/metering/application/usage-repository.port';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { Prisma } from '@prisma-client/client';
import { isRecord, safeNonNegativeCount } from './metering-row';
import type { PrismaMeteringClient } from './prisma-metering.client';

export { createPostgresMeteringClient } from './postgres-metering.fixture-client';
export type { PrismaMeteringClient } from './prisma-metering.client';

const AGGREGATE_SQL = `
  SELECT
    COALESCE(SUM(billable_requests) FILTER (WHERE outcome = 'success'), 0)::bigint AS billable_request_count,
    COALESCE(SUM(total_tokens) FILTER (WHERE outcome = 'success' AND billable_requests = 1), 0)::bigint AS billable_token_count,
    COUNT(*) FILTER (WHERE outcome = 'success' AND metering_status = 'missing_usage')::bigint AS missing_usage_count
  FROM usage_records
  WHERE organization_id = $1
    AND created_at >= $2
    AND created_at < $3
    AND ($4::text IS NULL OR operation = $4)
`;

function aggregateNumber(value: unknown, field: string): number {
  const parsed = safeNonNegativeCount(value);
  if (parsed === undefined) {
    throw new Error(`usage aggregate field ${field} is invalid`);
  }
  return parsed;
}

function aggregateFromRow(row: unknown): UsageAggregate {
  if (!isRecord(row)) {
    throw new Error('usage aggregate row is invalid');
  }

  return {
    billableRequestCount: aggregateNumber(
      row.billable_request_count,
      'billable_request_count',
    ),
    billableTokenCount: aggregateNumber(
      row.billable_token_count,
      'billable_token_count',
    ),
    missingUsageCount: aggregateNumber(
      row.missing_usage_count,
      'missing_usage_count',
    ),
  };
}

interface UsageAggregateRow {
  readonly billable_request_count: bigint;
  readonly billable_token_count: bigint;
  readonly missing_usage_count: bigint;
}

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

  async aggregate(query: UsageAggregateQuery): Promise<UsageAggregate> {
    const rows = await this.client.$queryRawUnsafe<
      readonly UsageAggregateRow[]
    >(
      AGGREGATE_SQL,
      query.organizationId,
      query.from,
      query.to,
      query.operation ?? null,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('usage aggregate query returned no row');
    }
    return aggregateFromRow(row);
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
