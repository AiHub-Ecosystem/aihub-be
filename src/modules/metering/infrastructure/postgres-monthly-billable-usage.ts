import type { MonthlyBillableUsagePort } from '@/modules/metering/application/monthly-billable-usage.port';
import { billableRequestSql } from './billable-request-sql';
import { safeNonNegativeCount } from './metering-row';
import type { PrismaMeteringClient } from './prisma-metering.client';

/** One Organization's billable count, with the reconciliation job's filter. */
export const MONTHLY_BILLABLE_USAGE_SQL = `
  SELECT COUNT(*) FILTER (
    WHERE ${billableRequestSql()}
  )::bigint AS billable_count
  FROM usage_records
  WHERE organization_id = $1
    AND created_at >= $2
    AND created_at < $3
`;

/**
 * Durable usage for seeding a quota counter Redis lost (#371). It counts the
 * same rows `quota:reconcile` overwrites the counter with.
 */
export class PostgresMonthlyBillableUsage implements MonthlyBillableUsagePort {
  constructor(private readonly client: PrismaMeteringClient) {}

  async billableCount(
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<
      readonly { readonly billable_count: unknown }[]
    >(MONTHLY_BILLABLE_USAGE_SQL, organizationId, from, to);
    const count = safeNonNegativeCount(rows[0]?.billable_count);
    if (count === undefined) {
      throw new Error('monthly billable usage is invalid');
    }
    return count;
  }
}
