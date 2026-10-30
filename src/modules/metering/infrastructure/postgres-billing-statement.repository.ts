import { asDate } from '@/common/postgres/row-readers';
import {
  type BillingAdjustmentRecord,
  type BillingAdjustmentTarget,
  type BillingAdjustmentWriteResult,
  type BillingClosureRecord,
  type BillingMonth,
  type BillingStatementLine,
  type BillingStatementRepositoryPort,
  type BillingUsageRow,
  type NewBillingAdjustment,
  parseBillingMonth,
} from '@/modules/metering/application/billing-statement';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { billableRequestSql } from './billable-request-sql';
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
    COUNT(*) FILTER (WHERE ${billableRequestSql()}
      AND environment = 'production' AND NOT internal
      AND billing_basis = 'response')::bigint AS billable_responses,
    COUNT(*) FILTER (WHERE ${billableRequestSql()}
      AND environment = 'production' AND NOT internal
      AND billing_basis = 'background_completion')::bigint AS billable_background,
    COUNT(*) FILTER (WHERE ${billableRequestSql()}
      AND environment = 'production' AND NOT internal
      AND metering_status = 'quota_unverified')::bigint AS quota_unverified,
    COUNT(*) FILTER (WHERE outcome = 'success'
      AND billable_requests = 0)::bigint AS excluded_replays,
    COUNT(*) FILTER (WHERE outcome <> 'success')::bigint AS excluded_failures,
    COUNT(*) FILTER (WHERE ${billableRequestSql()}
      AND environment = 'production' AND internal)::bigint AS excluded_internal,
    COUNT(*) FILTER (WHERE ${billableRequestSql()}
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

/**
 * An adjustment, and the closure totals it feeds, may be negative: a credit
 * removes billed requests (migration 0039 only refuses zero). So these fields
 * take any safe integer instead of the non-negative count decode.
 */
function signedCount(value: unknown, field: string): number {
  const parsed =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
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
  const parsed = asDate(value);
  if (parsed === undefined) {
    throw new Error(`billing field ${field} is invalid`);
  }
  return parsed;
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
      requests: signedCount(row.requests, 'requests'),
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
      adjustmentRequests: signedCount(
        row.adjustment_requests,
        'adjustment_requests',
      ),
      totalRequests: signedCount(row.total_requests, 'total_requests'),
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
  ): Promise<BillingAdjustmentWriteResult> {
    // An adjustment racing a close can land after the close read its totals;
    // the next statement for that month then reports the difference.
    return this.client.$transaction(async (transaction) => {
      const existing = await transaction.billingAdjustment.findUnique({
        where: { id: input.id },
      });
      if (existing !== null) {
        return {
          status: 'existing' as const,
          adjustment: existingAdjustment(existing),
        };
      }
      const closed = await transaction.billingMonthClosure.count({
        where: {
          organizationId: input.organizationId,
          billingMonth: input.month.from,
        },
      });
      if (closed > 0) {
        return { status: 'month_closed' as const };
      }
      const created = await transaction.billingAdjustment.createMany({
        data: [
          {
            id: input.id,
            organizationId: input.organizationId,
            billingMonth: input.month.from,
            operation: input.operation,
            requests: input.requests,
            reason: input.reason,
            corrects: storedTarget(input.corrects),
            actor: input.actor,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count > 0) {
        return { status: 'created' as const, adjustment: input };
      }
      const duplicate = await transaction.billingAdjustment.findUnique({
        where: { id: input.id },
      });
      if (duplicate === null) {
        throw new Error(
          'billing adjustment identity conflict could not be read',
        );
      }
      return {
        status: 'existing' as const,
        adjustment: existingAdjustment(duplicate),
      };
    }, CONTROL_PLANE_TRANSACTION_OPTIONS);
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }
}

function existingAdjustment(record: {
  readonly id: string;
  readonly organizationId: string;
  readonly billingMonth: Date;
  readonly operation: string;
  readonly requests: number;
  readonly reason: string;
  readonly corrects: unknown;
  readonly actor: string;
}): NewBillingAdjustment {
  return {
    id: record.id,
    organizationId: record.organizationId,
    month: parseBillingMonth(record.billingMonth.toISOString().slice(0, 7)),
    operation: record.operation,
    requests: record.requests,
    reason: record.reason,
    corrects: target(record.corrects),
    actor: record.actor,
  };
}
