import { isRecord } from '@/common/is-record';
import type {
  PublicApiMajorCollectorRow,
  PublicApiMajorUsageDroppedInterval,
} from '@/modules/metering/application/public-api-major-coverage';
import {
  type PublicApiMajorOrganizationRow,
  type PublicApiMajorSnapshot,
  type PublicApiMajorTotalRow,
  type PublicApiMajorUnattributedTotalRow,
  type PublicApiMajorUsageRepositoryPort,
  type PublicApiMajorUsageWrite,
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

export const PUBLIC_API_MAJOR_UNATTRIBUTED_ADD_SQL = `
  INSERT INTO public_api_major_unattributed_usage
    (usage_day, environment, major, caller_kind, request_count, failure_count)
  SELECT t.usage_day, $1, t.major, t.caller_kind, t.request_count, t.failure_count
  FROM unnest($2::date[], $3::integer[], $4::text[], $5::bigint[], $6::bigint[])
    AS t(usage_day, major, caller_kind, request_count, failure_count)
  ON CONFLICT (usage_day, environment, major, caller_kind) DO UPDATE SET
    request_count = public_api_major_unattributed_usage.request_count + EXCLUDED.request_count,
    failure_count = public_api_major_unattributed_usage.failure_count + EXCLUDED.failure_count
`;

// Coverage only moves forward, and a clean stop, once recorded, stays. A write
// numbered at or below the process's applied one was committed before: no row
// comes back, and its counts are not added again.
export const PUBLIC_API_MAJOR_COVERAGE_ADD_SQL = `
  INSERT INTO public_api_major_usage_coverage
    (process_id, environment, started_at, covered_through, stopped_cleanly_at,
     applied_batch)
  VALUES ($1::uuid, $2, $3, $4, $5, $6)
  ON CONFLICT (process_id) DO UPDATE SET
    covered_through = GREATEST(public_api_major_usage_coverage.covered_through, EXCLUDED.covered_through),
    stopped_cleanly_at = COALESCE(public_api_major_usage_coverage.stopped_cleanly_at, EXCLUDED.stopped_cleanly_at),
    applied_batch = EXCLUDED.applied_batch
  WHERE public_api_major_usage_coverage.applied_batch < EXCLUDED.applied_batch
  RETURNING applied_batch
`;

export const PUBLIC_API_MAJOR_DROPPED_INTERVAL_ADD_SQL = `
  INSERT INTO public_api_major_usage_dropped_interval
    (process_id, batch, environment, dropped_from, dropped_through)
  VALUES ($1::uuid, $2, $3, $4, $5)
`;

// Must be the transaction's first statement: every read after it sees one
// snapshot, and `as_of` names the moment the report describes.
const SNAPSHOT_TRANSACTION_SQL =
  'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY';

const AS_OF_SQL = 'SELECT clock_timestamp() AS as_of';

export const PUBLIC_API_MAJOR_TOTALS_SQL = `
  SELECT
    environment,
    major,
    SUM(request_count)::bigint AS request_count,
    SUM(failure_count)::bigint AS failure_count,
    COALESCE(SUM(request_count) FILTER (WHERE organization_id = ''), 0)::bigint
      AS unattributed_count,
    COALESCE(SUM(failure_count) FILTER (WHERE organization_id = ''), 0)::bigint
      AS unattributed_failure_count
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

export const PUBLIC_API_MAJOR_UNATTRIBUTED_SQL = `
  SELECT
    environment,
    major,
    caller_kind,
    SUM(request_count)::bigint AS request_count,
    SUM(failure_count)::bigint AS failure_count
  FROM public_api_major_unattributed_usage
  WHERE usage_day >= $1::date AND usage_day < $2::date
  GROUP BY environment, major, caller_kind
`;

// Every process whose collection overlaps the window. One that ended before
// the window starts cannot cover any of it.
export const PUBLIC_API_MAJOR_COLLECTORS_SQL = `
  SELECT environment, started_at, covered_through, stopped_cleanly_at
  FROM public_api_major_usage_coverage
  WHERE started_at < $2::date AND covered_through >= $1::date
`;

export const PUBLIC_API_MAJOR_DROPPED_INTERVALS_SQL = `
  SELECT environment, dropped_from, dropped_through
  FROM public_api_major_usage_dropped_interval
  WHERE dropped_from < $2::date AND dropped_through >= $1::date
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
    unattributedFailureCount: count(row.unattributed_failure_count),
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

function unattributedFromRow(row: unknown): PublicApiMajorUnattributedTotalRow {
  if (!isRecord(row)) {
    throw new PublicApiMajorSnapshotError();
  }
  return {
    environment: text(row.environment),
    major: count(row.major),
    callerKind: text(row.caller_kind),
    requestCount: count(row.request_count),
    failureCount: count(row.failure_count),
  };
}

function collectorFromRow(row: unknown): PublicApiMajorCollectorRow {
  if (
    !isRecord(row) ||
    !(row.started_at instanceof Date) ||
    !(row.covered_through instanceof Date) ||
    !(row.stopped_cleanly_at === null || row.stopped_cleanly_at instanceof Date)
  ) {
    throw new PublicApiMajorSnapshotError();
  }
  return {
    environment: text(row.environment),
    startedAt: row.started_at,
    coveredThrough: row.covered_through,
    stoppedCleanlyAt: row.stopped_cleanly_at,
  };
}

function droppedIntervalFromRow(
  row: unknown,
): PublicApiMajorUsageDroppedInterval {
  if (
    !isRecord(row) ||
    !(row.dropped_from instanceof Date) ||
    !(row.dropped_through instanceof Date)
  ) {
    throw new PublicApiMajorSnapshotError();
  }
  return {
    environment: text(row.environment),
    droppedFrom: row.dropped_from,
    droppedThrough: row.dropped_through,
  };
}

export class PostgresPublicApiMajorUsageRepository
  implements PublicApiMajorUsageRepositoryPort
{
  constructor(private readonly client: PrismaMeteringClient) {}

  async add(
    environment: string,
    write: PublicApiMajorUsageWrite,
  ): Promise<void> {
    const { rows, unattributed, collector } = write;
    await this.client.$transaction(async (transaction) => {
      const applied = await transaction.$queryRawUnsafe<readonly unknown[]>(
        PUBLIC_API_MAJOR_COVERAGE_ADD_SQL,
        collector.processId,
        environment,
        collector.startedAt,
        write.coveredThrough,
        write.stoppedCleanly ? write.coveredThrough : null,
        write.batch,
      );
      if (applied.length === 0) {
        return;
      }
      if (write.droppedFrom !== null && write.droppedThrough !== null) {
        await transaction.$executeRawUnsafe(
          PUBLIC_API_MAJOR_DROPPED_INTERVAL_ADD_SQL,
          collector.processId,
          write.batch,
          environment,
          write.droppedFrom,
          write.droppedThrough,
        );
      }
      if (rows.length > 0) {
        await transaction.$executeRawUnsafe(
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
      if (unattributed.length > 0) {
        await transaction.$executeRawUnsafe(
          PUBLIC_API_MAJOR_UNATTRIBUTED_ADD_SQL,
          environment,
          unattributed.map((row) => row.usageDay),
          unattributed.map((row) => row.major),
          unattributed.map((row) => row.callerKind),
          unattributed.map((row) => row.requestCount),
          unattributed.map((row) => row.failureCount),
        );
      }
    });
  }

  async snapshot(
    window: PublicApiMajorWindow,
  ): Promise<PublicApiMajorSnapshot> {
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(SNAPSHOT_TRANSACTION_SQL);
      const read = (
        sql: string,
        ...values: unknown[]
      ): Promise<readonly unknown[]> =>
        transaction.$queryRawUnsafe<readonly unknown[]>(sql, ...values);
      const [asOf] = await read(AS_OF_SQL);
      const totals = await read(
        PUBLIC_API_MAJOR_TOTALS_SQL,
        window.fromDay,
        window.toDay,
      );
      const organizations = await read(
        PUBLIC_API_MAJOR_ORGANIZATIONS_SQL,
        window.fromDay,
        window.toDay,
      );
      const unattributed = await read(
        PUBLIC_API_MAJOR_UNATTRIBUTED_SQL,
        window.fromDay,
        window.toDay,
      );
      const collectors = await read(
        PUBLIC_API_MAJOR_COLLECTORS_SQL,
        window.fromDay,
        window.toDay,
      );
      const droppedIntervals = await read(
        PUBLIC_API_MAJOR_DROPPED_INTERVALS_SQL,
        window.fromDay,
        window.toDay,
      );
      const [start] = await read(PUBLIC_API_MAJOR_COVERAGE_SQL);
      if (!isRecord(asOf) || !(asOf.as_of instanceof Date)) {
        throw new PublicApiMajorSnapshotError();
      }
      return {
        asOf: asOf.as_of,
        coverageStartDay:
          isRecord(start) && typeof start.coverage_start_day === 'string'
            ? start.coverage_start_day
            : undefined,
        totals: totals.map(totalFromRow),
        organizations: organizations.map(organizationFromRow),
        unattributed: unattributed.map(unattributedFromRow),
        collectors: collectors.map(collectorFromRow),
        droppedIntervals: droppedIntervals.map(droppedIntervalFromRow),
      };
    });
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }
}
