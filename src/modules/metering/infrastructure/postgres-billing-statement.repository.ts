import type {
  BillingAdjustmentRecord,
  BillingAdjustmentTarget,
  BillingClosureRecord,
  BillingMonth,
  BillingStatementLine,
  BillingStatementRepositoryPort,
  BillingUsageRow,
  NewBillingAdjustment,
} from '@/modules/metering/application/billing-statement';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { safeNonNegativeCount } from './metering-row';
import type { PrismaMeteringClient } from './prisma-metering.client';

// Both month bounds, and every reason a request is not billed counted beside
// what is. A key that no longer exists is not internal.
export const BILLING_USAGE_SQL = `
  WITH scoped AS (
    SELECT
      u.organization_id,
      u.operation,
      u.outcome,
      u.billable_requests,
      u.environment,
      u.metering_status,
      u.billing_basis,
      COALESCE(k.internal, false) AS internal
    FROM usage_records AS u
    LEFT JOIN api_keys AS k ON k.id = u.api_key_id
    WHERE u.created_at >= $1
      AND u.created_at < $2
      AND ($3::text IS NULL OR u.organization_id = $3)
  )
  SELECT
    organization_id,
    operation,
    COUNT(*) FILTER (WHERE outcome = 'success' AND billable_requests = 1
      AND environment = 'production' AND NOT internal
      AND billing_basis = 'response')::bigint AS billable_responses,
    COUNT(*) FILTER (WHERE outcome = 'success' AND billable_requests = 1
      AND environment = 'production' AND NOT internal
      AND billing_basis = 'background_completion')::bigint AS billable_background,
    COUNT(*) FILTER (WHERE outcome = 'success' AND billable_requests = 1
      AND environment = 'production' AND NOT internal
      AND metering_status = 'quota_unverified')::bigint AS quota_unverified,
    COUNT(*) FILTER (WHERE outcome = 'success'
      AND billable_requests = 0)::bigint AS excluded_replays,
    COUNT(*) FILTER (WHERE outcome <> 'success')::bigint AS excluded_failures,
    COUNT(*) FILTER (WHERE outcome = 'success' AND billable_requests = 1
      AND environment = 'production' AND internal)::bigint AS excluded_internal,
    COUNT(*) FILTER (WHERE outcome = 'success' AND billable_requests = 1
      AND environment <> 'production')::bigint AS excluded_non_production
  FROM scoped
  GROUP BY organization_id, operation
  ORDER BY organization_id, operation
`;

const ADJUSTMENTS_SQL = `
  SELECT id, organization_id, operation, requests, reason, corrects, actor, created_at
  FROM billing_adjustments
  WHERE billing_month = $1::date
    AND ($2::text IS NULL OR organization_id = $2)
  ORDER BY organization_id, created_at, id
`;

const CLOSURES_SQL = `
  SELECT organization_id, operation, billable_requests, adjustment_requests,
         total_requests, closed_by, closed_at
  FROM billing_month_closures
  WHERE billing_month = $1::date
    AND ($2::text IS NULL OR organization_id = $2)
  ORDER BY organization_id, operation
`;

function count(value: unknown, field: string): number {
  const parsed = safeNonNegativeCount(value);
  if (parsed === undefined) {
    throw new Error(`billing field ${field} is invalid`);
  }
  return parsed;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`billing field ${field} is invalid`);
  }
  return value;
}

function date(value: unknown, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`billing field ${field} is invalid`);
  }
  return value;
}

function target(value: unknown): BillingAdjustmentTarget {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (
      Array.isArray(record.request_ids) &&
      record.request_ids.every((id) => typeof id === 'string')
    ) {
      return { requestIds: record.request_ids as string[] };
    }
    const period = record.period as Record<string, unknown> | undefined;
    if (typeof period?.from === 'string' && typeof period.to === 'string') {
      return { period: { from: period.from, to: period.to } };
    }
  }
  throw new Error('billing field corrects is invalid');
}

function storedTarget(value: BillingAdjustmentTarget): object {
  return 'requestIds' in value
    ? { request_ids: [...value.requestIds] }
    : { period: { from: value.period.from, to: value.period.to } };
}

function monthDate(month: BillingMonth): string {
  return month.from.toISOString().slice(0, 10);
}

export class PostgresBillingStatementRepository
  implements BillingStatementRepositoryPort
{
  constructor(private readonly client: PrismaMeteringClient) {}

  async usage(
    month: BillingMonth,
    organizationId: string | undefined,
  ): Promise<readonly BillingUsageRow[]> {
    const rows = await this.client.$queryRawUnsafe<
      readonly Record<string, unknown>[]
    >(BILLING_USAGE_SQL, month.from, month.to, organizationId ?? null);
    return rows.map((row) => ({
      organizationId: text(row.organization_id, 'organization_id'),
      operation: text(row.operation, 'operation'),
      billableResponses: count(row.billable_responses, 'billable_responses'),
      billableBackgroundCompletions: count(
        row.billable_background,
        'billable_background',
      ),
      quotaUnverified: count(row.quota_unverified, 'quota_unverified'),
      excludedReplays: count(row.excluded_replays, 'excluded_replays'),
      excludedFailures: count(row.excluded_failures, 'excluded_failures'),
      excludedInternal: count(row.excluded_internal, 'excluded_internal'),
      excludedNonProduction: count(
        row.excluded_non_production,
        'excluded_non_production',
      ),
    }));
  }

  async adjustments(
    month: BillingMonth,
    organizationId: string | undefined,
  ): Promise<readonly BillingAdjustmentRecord[]> {
    const rows = await this.client.$queryRawUnsafe<
      readonly Record<string, unknown>[]
    >(ADJUSTMENTS_SQL, monthDate(month), organizationId ?? null);
    return rows.map((row) => ({
      id: text(row.id, 'id'),
      organizationId: text(row.organization_id, 'organization_id'),
      operation: text(row.operation, 'operation'),
      requests: count(row.requests, 'requests'),
      reason: text(row.reason, 'reason'),
      corrects: target(row.corrects),
      actor: text(row.actor, 'actor'),
      createdAt: date(row.created_at, 'created_at'),
    }));
  }

  async closures(
    month: BillingMonth,
    organizationId: string | undefined,
  ): Promise<readonly BillingClosureRecord[]> {
    const rows = await this.client.$queryRawUnsafe<
      readonly Record<string, unknown>[]
    >(CLOSURES_SQL, monthDate(month), organizationId ?? null);
    return rows.map((row) => ({
      organizationId: text(row.organization_id, 'organization_id'),
      operation: text(row.operation, 'operation'),
      billableRequests: count(row.billable_requests, 'billable_requests'),
      adjustmentRequests: count(row.adjustment_requests, 'adjustment_requests'),
      totalRequests: count(row.total_requests, 'total_requests'),
      closedBy: text(row.closed_by, 'closed_by'),
      closedAt: date(row.closed_at, 'closed_at'),
    }));
  }

  async closeMonth(
    month: BillingMonth,
    lines: readonly BillingStatementLine[],
    actor: string,
  ): Promise<void> {
    // One transaction: a month is closed for an Organization with all of its
    // operations or not at all. The primary key refuses a second close.
    await this.client.$transaction(async (transaction) => {
      await transaction.billingMonthClosure.createMany({
        data: lines.map((line) => ({
          organizationId: line.organizationId,
          billingMonth: month.from,
          operation: line.operation,
          billableRequests: line.billableRequests,
          adjustmentRequests: line.adjustmentRequests,
          totalRequests: line.totalRequests,
          closedBy: actor,
        })),
      });
    }, CONTROL_PLANE_TRANSACTION_OPTIONS);
  }

  async addAdjustment(
    input: NewBillingAdjustment,
  ): Promise<'created' | 'month_closed'> {
    // An adjustment racing a close can land after the close read its totals;
    // the next statement for that month then reports the difference.
    return this.client.$transaction(async (transaction) => {
      const closed = await transaction.billingMonthClosure.count({
        where: {
          organizationId: input.organizationId,
          billingMonth: input.month.from,
        },
      });
      if (closed > 0) {
        return 'month_closed' as const;
      }
      await transaction.billingAdjustment.create({
        data: {
          id: input.id,
          organizationId: input.organizationId,
          billingMonth: input.month.from,
          operation: input.operation,
          requests: input.requests,
          reason: input.reason,
          corrects: storedTarget(input.corrects),
          actor: input.actor,
        },
      });
      return 'created' as const;
    }, CONTROL_PLANE_TRANSACTION_OPTIONS);
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }
}
