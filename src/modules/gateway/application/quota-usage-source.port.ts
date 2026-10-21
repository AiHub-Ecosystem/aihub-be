/** Durable monthly usage, for rebuilding a quota counter Redis lost (#371). */
export interface QuotaUsageSourcePort {
  /** Billable requests recorded for the Organization in `[from, to)`. */
  billableCount(organizationId: string, from: Date, to: Date): Promise<number>;
}

export const QUOTA_USAGE_SOURCE = Symbol('QUOTA_USAGE_SOURCE');
