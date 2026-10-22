import { AppError } from '@/common/errors/app-error';

import { stableOffsetMs } from './retry-hint';

/**
 * How far past the month boundary a quota refusal's hint may point. Each
 * Organization gets its own fixed offset in this range, so hard-stopped
 * Organizations do not all come back at 00:00 UTC on the 1st (#403).
 */
export const QUOTA_ROLLOVER_SPREAD_MS = 10 * 60_000;

export interface QuotaPeriod {
  readonly year: number;
  /** Zero-based, matching `Date.prototype.getUTCMonth`. */
  readonly monthIndex: number;
  /** `YYYY-MM`: the Redis quota key suffix and the reconciliation month. */
  readonly key: string;
  /** `YYYYMM`: the Sandbox dispatch budget's month column and advisory lock. */
  readonly monthNumber: number;
  /** First instant of the month, UTC. */
  readonly start: Date;
  /** First instant of the next month, UTC; exclusive. */
  readonly end: Date;
}

export interface QuotaPeriodAt extends QuotaPeriod {
  /** Milliseconds from the given instant to the start of the next month. */
  readonly retryAfterMs: number;
}

/**
 * The monthly request quota is one UTC calendar month, and this is the only
 * place its boundaries are derived. Callers that persist a month read `key` or
 * `monthNumber`; callers that answer a refusal read `end` or `retryAfterMs`.
 */
export function quotaMonth(year: number, monthIndex: number): QuotaPeriod {
  return {
    year,
    monthIndex,
    key: `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}`,
    monthNumber: year * 100 + monthIndex + 1,
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

/** The quota period an instant falls in, and the time left to run out of it. */
export function quotaPeriod(now: Date): QuotaPeriodAt {
  const month = quotaMonth(now.getUTCFullYear(), now.getUTCMonth());
  return {
    ...month,
    retryAfterMs: Math.max(0, month.end.getTime() - now.getTime()),
  };
}

/**
 * Reads a `YYYY-MM` label back into the period it names. Returns `undefined`
 * for anything that is not a valid month, so a caller can keep its own answer
 * for a malformed label: a typed error, a usage error, or a silent skip.
 * The 1-based month in the label becomes the 0-based index here, once.
 */
export function parseQuotaMonth(label: string): QuotaPeriod | undefined {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    return undefined;
  }
  return quotaMonth(year, month - 1);
}

export function quotaExceededError(
  now: Date,
  organizationId: string,
): AppError {
  return new AppError({
    code: 'QUOTA_EXCEEDED',
    message: 'Monthly request quota exceeded',
    retryable: true,
    retryAfterMs:
      quotaPeriod(now).retryAfterMs +
      stableOffsetMs(organizationId, QUOTA_ROLLOVER_SPREAD_MS),
  });
}
