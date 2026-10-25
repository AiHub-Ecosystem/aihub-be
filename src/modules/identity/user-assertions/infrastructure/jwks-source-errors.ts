import { AppError } from '@/common/errors/app-error';

export function unsafeUrl(): AppError {
  return new AppError({
    code: 'IDENTITY_JWKS_URL_UNSAFE',
    message: 'JWKS URL is not safe',
    retryable: false,
  });
}

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

export function invalidJwks(): AppError {
  return new AppError({
    code: 'IDENTITY_JWKS_INVALID',
    message: 'Public JWKS is invalid',
    retryable: false,
  });
}
