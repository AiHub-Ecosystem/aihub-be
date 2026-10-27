import { isRecord } from '@/common/is-record';
import {
  type UsageReportRepositoryPort,
  UsageReportSnapshotError,
  type UsageReportSnapshotQuery,
  type UsageReportSnapshotRow,
} from '@/modules/metering/application/usage-completeness-report';
import { billableRequestSql } from './billable-request-sql';
import { safeNonNegativeCount } from './metering-row';
import type { PrismaMeteringClient } from './prisma-metering.client';

export const USAGE_REPORT_SQL = `
  SELECT
    operation,
    COUNT(*) FILTER (
      WHERE ${billableRequestSql()}
    )::bigint AS successful_count,
    COUNT(*) FILTER (
      WHERE ${billableRequestSql()}
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
  const parsed = safeNonNegativeCount(value);
  if (parsed === undefined) {
    throw new UsageReportSnapshotError();
  }
  return parsed;
}

interface UsageReportRow {
  readonly operation: string;
  readonly successful_count: bigint;
  readonly missing_usage_count: bigint;
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
  constructor(private readonly client: PrismaMeteringClient) {}

  async snapshot(
    query: UsageReportSnapshotQuery,
  ): Promise<readonly UsageReportSnapshotRow[]> {
    const rows = await this.client.$queryRawUnsafe<readonly UsageReportRow[]>(
      USAGE_REPORT_SQL,
      query.from,
      query.to,
      [...query.operations],
    );
    return rows
      .map(snapshotFromRow)
      .sort((left, right) => left.operation.localeCompare(right.operation));
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }
}
