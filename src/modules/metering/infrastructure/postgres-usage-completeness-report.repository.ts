import {
  type UsageReportRepositoryPort,
  UsageReportSnapshotError,
  type UsageReportSnapshotQuery,
  type UsageReportSnapshotRow,
} from '@/modules/metering/application/usage-completeness-report';
import {
  type PostgresMeteringClient,
  createPostgresMeteringClient,
  isRecord,
} from './postgres-usage.repository';

export const USAGE_REPORT_SQL = `
  SELECT
    operation,
    COUNT(*) FILTER (
      WHERE outcome = 'success' AND billable_requests = 1
    )::bigint AS successful_count,
    COUNT(*) FILTER (
      WHERE outcome = 'success'
        AND billable_requests = 1
        AND metering_status = 'missing_usage'
    )::bigint AS missing_usage_count
  FROM usage_records
  WHERE created_at >= $1
    AND created_at < $2
    AND operation = ANY($3::text[])
  GROUP BY operation
  ORDER BY operation
`;

function countFromRow(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new UsageReportSnapshotError();
  }
  return parsed;
}

function snapshotFromRow(value: unknown): UsageReportSnapshotRow {
  if (
    !isRecord(value) ||
    typeof value.operation !== 'string' ||
    value.operation.length === 0
  ) {
    throw new UsageReportSnapshotError();
  }
  return {
    operation: value.operation,
    successfulCount: countFromRow(value.successful_count),
    missingUsageCount: countFromRow(value.missing_usage_count),
  };
}

export class PostgresUsageCompletenessReportRepository
  implements UsageReportRepositoryPort
{
  constructor(private readonly client: PostgresMeteringClient) {}

  async snapshot(
    query: UsageReportSnapshotQuery,
  ): Promise<readonly UsageReportSnapshotRow[]> {
    const rows = await this.client.query(USAGE_REPORT_SQL, [
      query.from,
      query.to,
      [...query.operations],
    ]);
    return rows
      .map(snapshotFromRow)
      .sort((left, right) => left.operation.localeCompare(right.operation));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export function createPostgresUsageCompletenessReportRepository(
  databaseUrl: string,
): PostgresUsageCompletenessReportRepository {
  return new PostgresUsageCompletenessReportRepository(
    createPostgresMeteringClient(databaseUrl),
  );
}
