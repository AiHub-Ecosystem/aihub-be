import { Pool } from 'pg';

import type {
  UsageAggregate,
  UsageAggregateQuery,
  UsageRecord,
  UsageRepositoryPort,
} from '../application/usage-repository.port';

export interface PostgresMeteringClient {
  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
  close(): Promise<void>;
}

export function createPostgresMeteringClient(
  databaseUrl: string,
): PostgresMeteringClient {
  if (databaseUrl.trim().length === 0) {
    return {
      query: async () => {
        throw new Error('DATABASE_URL is missing');
      },
      close: async () => undefined,
    };
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
  });

  return {
    async query(
      text: string,
      values: readonly unknown[],
    ): Promise<readonly unknown[]> {
      const result = await pool.query<Record<string, unknown>>(text, [
        ...values,
      ]);
      return result.rows;
    },
    close: async () => {
      await pool.end();
    },
  };
}

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
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`usage aggregate field ${field} is invalid`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export class PostgresUsageRepository implements UsageRepositoryPort {
  constructor(private readonly client: PostgresMeteringClient) {}

  async insert(record: UsageRecord): Promise<void> {
    const rows = await this.client.query(INSERT_SQL, recordValues(record));
    if (rows.length === 0) {
      throw new Error('usage record was not inserted');
    }
  }

  async aggregate(query: UsageAggregateQuery): Promise<UsageAggregate> {
    const rows = await this.client.query(AGGREGATE_SQL, [
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
