import { isUsableCount } from '@/common/counts/is-usable-count';
import { AppError } from '@/common/errors/app-error';

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
 * A hard-stop quota that could not be checked. It is not a quota refusal, so it
 * never carries next month's retry hint (#373); it fails closed like graded
 * admission does (ADR-0116).
 */
export function quotaUnverifiableError(): AppError {
  return new AppError({
    code: 'REDIS_UNAVAILABLE',
    message: 'Quota could not be verified',
    retryable: true,
    retryAfterMs: 1_000,
  });
}

/**
 * Decides whether a production request fits the monthly quota. A counter that
 * cannot be read, or reads an unsafe value, is never taken as zero: a hard-stop
 * quota refuses with a short retryable answer, any other admits and says the
 * quota went unverified.
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
      throw quotaUnverifiableError();
    }
    return 'unverified';
  }

  if (count >= input.quota) {
    throw quotaExceededError(now());
  }
  return 'verified';
}
