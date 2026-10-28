import { isRecord } from '@/common/is-record';
import {
  type PublicApiMajorOrganizationRow,
  type PublicApiMajorSnapshot,
  type PublicApiMajorTotalRow,
  type PublicApiMajorUsageRepositoryPort,
  type PublicApiMajorUsageRow,
  type PublicApiMajorWindow,
} from '@/modules/metering/application/public-api-major-usage';
import { safeNonNegativeCount } from './metering-row';
import type { PrismaMeteringClient } from './prisma-metering.client';

export const PUBLIC_API_MAJOR_ADD_SQL = `
  INSERT INTO public_api_major_usage
    (usage_day, environment, major, organization_id,
     request_count, failure_count, last_seen_at)
  SELECT t.usage_day, $1, t.major, t.organization_id,
         t.request_count, t.failure_count, t.last_seen_at
  FROM unnest(
    $2::date[], $3::integer[], $4::text[],
    $5::bigint[], $6::bigint[], $7::timestamptz[]
  ) AS t(usage_day, major, organization_id,
         request_count, failure_count, last_seen_at)
  ON CONFLICT (usage_day, environment, major, organization_id) DO UPDATE SET
    request_count = public_api_major_usage.request_count + EXCLUDED.request_count,
    failure_count = public_api_major_usage.failure_count + EXCLUDED.failure_count,
    last_seen_at = GREATEST(public_api_major_usage.last_seen_at, EXCLUDED.last_seen_at)
`;

export const PUBLIC_API_MAJOR_TOTALS_SQL = `
  SELECT
    environment,
    major,
    SUM(request_count)::bigint AS request_count,
    SUM(failure_count)::bigint AS failure_count,
    COALESCE(SUM(request_count) FILTER (WHERE organization_id = ''), 0)::bigint
      AS unattributed_count
  FROM public_api_major_usage
  WHERE usage_day >= $1::date AND usage_day < $2::date
  GROUP BY environment, major
`;

export const PUBLIC_API_MAJOR_ORGANIZATIONS_SQL = `
  SELECT
    environment,
    major,
    organization_id,
    SUM(request_count)::bigint AS request_count,
    MAX(last_seen_at) AS last_seen_at
  FROM public_api_major_usage
  WHERE usage_day >= $1::date AND usage_day < $2::date
    AND organization_id <> ''
  GROUP BY environment, major, organization_id
`;

export const PUBLIC_API_MAJOR_COVERAGE_SQL = `
  SELECT MIN(usage_day)::text AS coverage_start_day FROM public_api_major_usage
`;

export class PublicApiMajorSnapshotError extends Error {
  constructor() {
    super('public API major usage row is invalid');
  }
}

function count(value: unknown): number {
  const parsed = safeNonNegativeCount(value);
  if (parsed === undefined) {
    throw new PublicApiMajorSnapshotError();
  }
  return parsed;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PublicApiMajorSnapshotError();
  }
  return value;
}

function totalFromRow(row: unknown): PublicApiMajorTotalRow {
  if (!isRecord(row)) {
    throw new PublicApiMajorSnapshotError();
  }
  return {
    environment: text(row.environment),
    major: count(row.major),
    requestCount: count(row.request_count),
    failureCount: count(row.failure_count),
    unattributedCount: count(row.unattributed_count),
  };
}

function organizationFromRow(row: unknown): PublicApiMajorOrganizationRow {
  if (!isRecord(row) || !(row.last_seen_at instanceof Date)) {
    throw new PublicApiMajorSnapshotError();
  }
  return {
    environment: text(row.environment),
    major: count(row.major),
    organizationId: text(row.organization_id),
    requestCount: count(row.request_count),
    lastSeenAt: row.last_seen_at,
  };
}

export class PostgresPublicApiMajorUsageRepository
  implements PublicApiMajorUsageRepositoryPort
{
  constructor(private readonly client: PrismaMeteringClient) {}

  async add(
    environment: string,
    rows: readonly PublicApiMajorUsageRow[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.client.$executeRawUnsafe(
      PUBLIC_API_MAJOR_ADD_SQL,
      environment,
      rows.map((row) => row.usageDay),
      rows.map((row) => row.major),
      rows.map((row) => row.organizationId ?? ''),
      rows.map((row) => row.requestCount),
      rows.map((row) => row.failureCount),
      rows.map((row) => row.lastSeenAt),
    );
  }

  async snapshot(
    window: PublicApiMajorWindow,
  ): Promise<PublicApiMajorSnapshot> {
    const [totals, organizations, coverage] = await Promise.all([
      this.client.$queryRawUnsafe<readonly unknown[]>(
        PUBLIC_API_MAJOR_TOTALS_SQL,
        window.fromDay,
        window.toDay,
      ),
      this.client.$queryRawUnsafe<readonly unknown[]>(
        PUBLIC_API_MAJOR_ORGANIZATIONS_SQL,
        window.fromDay,
        window.toDay,
      ),
      this.client.$queryRawUnsafe<readonly unknown[]>(
        PUBLIC_API_MAJOR_COVERAGE_SQL,
      ),
    ]);
    const start = coverage[0];
    return {
      coverageStartDay:
        isRecord(start) && typeof start.coverage_start_day === 'string'
          ? start.coverage_start_day
          : undefined,
      totals: totals.map(totalFromRow),
      organizations: organizations.map(organizationFromRow),
    };
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }
}
