import { AppError } from '@/common/errors/app-error';

/** The public `RATE_LIMITED` answer: a retryable 429 with an optional hint. */
export function rateLimitedError(
  retryAfterMs: number | undefined,
  message = 'Rate limit exceeded',
): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message,
    retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
