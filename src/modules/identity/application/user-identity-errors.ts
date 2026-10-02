import { AppError } from '@/common/errors/app-error';

/** A header that is not a usable string, before the mode is known. */
export function invalidUserIdentity(): AppError {
  return new AppError({
    code: 'INVALID_USER_IDENTITY',
    message: 'User identity is invalid',
    retryable: false,
  });
}

/** Declared mode: the value breaks the End-User ID rule. */
export function invalidDeclaredUserId(): AppError {
  return new AppError({
    code: 'INVALID_USER_IDENTITY',
    message:
      'User identity must be 1-256 visible ASCII characters with no spaces',
    retryable: false,
  });
}

/**
 * Signed mode: any verification failure. The message never says which check
 * failed.
 */
export function invalidSignedUserAssertion(cause?: unknown): AppError {
  return new AppError({
    code: 'INVALID_USER_IDENTITY',
    message:
      'User identity must be a valid Signed User Assertion for this Organization',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** An identity-configuration store or JWKS outage; retryable, never a fallback. */
export function identityProviderUnavailable(cause?: unknown): AppError {
  return new AppError({
    code: 'IDENTITY_PROVIDER_UNAVAILABLE',
    message: 'Identity provider is unavailable',
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}
