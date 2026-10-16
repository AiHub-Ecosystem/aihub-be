import { AppError } from '@/common/errors/app-error';

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

export function quotaExceededError(now: Date): AppError {
  return new AppError({
    code: 'QUOTA_EXCEEDED',
    message: 'Monthly request quota exceeded',
    retryable: true,
    retryAfterMs: quotaPeriod(now).retryAfterMs,
  });
}
