import { AppError } from '@/common/errors/app-error';

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
