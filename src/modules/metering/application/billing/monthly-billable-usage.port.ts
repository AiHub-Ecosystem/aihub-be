/** Durable monthly usage, for rebuilding a quota counter Redis lost (#371). */
export interface MonthlyBillableUsagePort {
  /** Billable requests recorded for the Organization in `[from, to)`. */
  billableCount(organizationId: string, from: Date, to: Date): Promise<number>;
}

export const MONTHLY_BILLABLE_USAGE = Symbol('MONTHLY_BILLABLE_USAGE');
