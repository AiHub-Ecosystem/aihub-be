import { isUsableCount } from '@/common/counts/is-usable-count';

import type { QuotaCounterPort } from './quota-counter.port';
import { quotaExceededError } from './quota-period';

export interface QuotaAdmissionInput {
  readonly organizationId: string;
  readonly quota: number;
  readonly hardStopOnQuota: boolean;
}

/** `unverified`: admitted although the counter could not be trusted. */
export type QuotaAdmission = 'verified' | 'unverified';

/**
 * Decides whether a production request fits the monthly quota. A counter that
 * cannot be read, or reads an unsafe value, is never taken as zero: a hard-stop
 * quota refuses, any other admits and says the quota went unverified.
 */
export async function admitMonthlyQuota(
  counter: QuotaCounterPort,
  input: QuotaAdmissionInput,
  now: () => Date,
): Promise<QuotaAdmission> {
  let count: number;
  try {
    count = await counter.read({ organizationId: input.organizationId });
    if (!isUsableCount(count)) {
      throw new Error('quota counter value is invalid');
    }
  } catch {
    if (input.hardStopOnQuota) {
      throw quotaExceededError(now());
    }
    return 'unverified';
  }

  if (count >= input.quota) {
    throw quotaExceededError(now());
  }
  return 'verified';
}
