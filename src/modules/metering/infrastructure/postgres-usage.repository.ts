import type {
  UsageAggregate,
  UsageAggregateQuery,
  UsageRecord,
  UsageRepositoryPort,
} from '@/modules/metering/application/usage-repository.port';
import { isRecord } from './metering-row';
import type { PostgresMeteringClient } from './prisma-metering.client';

export { createPostgresMeteringClient } from './postgres-metering.fixture-client';
export type {
  PostgresMeteringClient,
  PostgresTransactionClient,
} from './prisma-metering.client';

const INSERT_SQL = `
  INSERT INTO usage_records (
    request_id,
    organization_id,
    api_key_id,
    actor_id,
    service,
    operation,
    environment,
    outcome,
    http_status,
    error_code,
    billable_requests,
    input_tokens,
    output_tokens,
    total_tokens,
    models,
    metering_status,
    total_ms,
    downstream_ms,
    ai_processing_ms
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
  ON CONFLICT (request_id) DO NOTHING
  RETURNING request_id
`;

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

function jsonModels(models: UsageRecord['models']): string | null {
  return models === undefined ? null : JSON.stringify(models);
}

function recordValues(record: UsageRecord): readonly unknown[] {
  return [
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
    jsonModels(record.models),
    record.meteringStatus,
    record.totalMs,
    record.downstreamMs ?? null,
    record.aiProcessingMs ?? null,
  ];
}

function aggregateNumber(value: unknown, field: string): number {
  const parsed =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
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

interface UsageInsertRow {
  readonly request_id: string;
}

interface UsageAggregateRow {
  readonly billable_request_count: bigint;
  readonly billable_token_count: bigint;
  readonly missing_usage_count: bigint;
}

export class PostgresUsageRepository implements UsageRepositoryPort {
  constructor(private readonly client: PostgresMeteringClient) {}

  async insert(record: UsageRecord): Promise<void> {
    await this.client.transaction(async (transaction) => {
      const rows = await transaction.query<UsageInsertRow>(
        INSERT_SQL,
        recordValues(record),
      );
      if (rows.length === 0) {
        throw new Error('usage record was not inserted');
      }
    });
  }

  async aggregate(query: UsageAggregateQuery): Promise<UsageAggregate> {
    const rows = await this.client.query<UsageAggregateRow>(AGGREGATE_SQL, [
      query.organizationId,
      query.from,
      query.to,
      query.operation ?? null,
    ]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('usage aggregate query returned no row');
    }
    return aggregateFromRow(row);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
