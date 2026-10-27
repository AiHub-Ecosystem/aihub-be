import { AppError } from '@/common/errors/app-error';

export function sourceUnavailable(
  retryable: boolean,
  cause?: unknown,
): AppError {
  return new AppError({
    code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
    message: 'JWKS source is unavailable',
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });
}
