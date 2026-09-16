import type {
  QuotaOrganizationSnapshot,
  QuotaReconciliationSnapshotPort,
  QuotaReconciliationTarget,
} from '../application/quota-reconciliation';
import {
  type PostgresMeteringClient,
  createPostgresMeteringClient,
} from './postgres-usage.repository';

export const QUOTA_RECONCILIATION_SQL = `
  SELECT
    o.id AS organization_id,
    o.monthly_request_quota AS quota,
    COALESCE(
      SUM(u.billable_requests) FILTER (WHERE u.outcome = 'success'),
      0
    )::bigint AS billable_count
  FROM organizations AS o
  LEFT JOIN usage_records AS u
    ON u.organization_id = o.id
   AND u.created_at >= $1
   AND u.created_at < $2
  WHERE o.monthly_request_quota IS NOT NULL
  GROUP BY o.id, o.monthly_request_quota
  ORDER BY o.id
`;

function safeNonNegativeInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`quota reconciliation field ${field} is invalid`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snapshotFromRow(value: unknown): QuotaOrganizationSnapshot {
  if (!isRecord(value)) {
    throw new Error('quota reconciliation row is invalid');
  }
  const row = value;
  if (
    typeof row.organization_id !== 'string' ||
    row.organization_id.length === 0
  ) {
    throw new Error('quota reconciliation organization is invalid');
  }

  const quota = row.quota ?? row.monthly_request_quota;
  return {
    organizationId: row.organization_id,
    monthlyRequestQuota:
      quota === null || quota === undefined
        ? null
        : safeNonNegativeInteger(quota, 'quota'),
    billableRequestCount: safeNonNegativeInteger(
      row.billable_count,
      'billable_count',
    ),
  };
}

function orderSnapshots(
  snapshots: readonly QuotaOrganizationSnapshot[],
): readonly QuotaOrganizationSnapshot[] {
  return [...snapshots].sort((left, right) => {
    if (left.organizationId < right.organizationId) return -1;
    if (left.organizationId > right.organizationId) return 1;
    return 0;
  });
}

export class PostgresQuotaReconciliationRepository
  implements QuotaReconciliationSnapshotPort
{
  constructor(private readonly client: PostgresMeteringClient) {}

  async list(
    target: QuotaReconciliationTarget,
  ): Promise<readonly QuotaOrganizationSnapshot[]> {
    const rows = await this.client.query(QUOTA_RECONCILIATION_SQL, [
      target.from,
      target.to,
    ]);
    return orderSnapshots(rows.map(snapshotFromRow));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export function createPostgresQuotaReconciliationRepository(
  databaseUrl: string,
): PostgresQuotaReconciliationRepository {
  return new PostgresQuotaReconciliationRepository(
    createPostgresMeteringClient(databaseUrl),
  );
}
