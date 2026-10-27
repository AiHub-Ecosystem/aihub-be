import { AppError } from '@/common/errors/app-error';

export function unsafeJwksUrl(): AppError {
  return new AppError({
    code: 'IDENTITY_JWKS_URL_UNSAFE',
    message: 'JWKS URL is not safe',
    retryable: false,
  });
}

export function invalidJwks(): AppError {
  return new AppError({
    code: 'IDENTITY_JWKS_INVALID',
    message: 'Public JWKS is invalid',
    retryable: false,
  });
}
