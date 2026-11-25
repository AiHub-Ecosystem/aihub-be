import { AppError } from '@/common/errors/app-error';
import { recordRejected } from '@/common/observability/metrics/rejected-metric';

/** A header that is not a usable string, before the mode is known. */
export function invalidUserIdentity(): AppError {
  return new AppError({
    code: 'INVALID_USER_IDENTITY',
    message: 'User identity is invalid',
    retryable: false,
  });
}

/** Declared mode: the value breaks the End-User ID rule. */
export { invalidDeclaredUserId } from '@/common/security/end-user-id';

const INVALID_SIGNED_ASSERTION_MESSAGE =
  'User identity must be a valid Signed User Assertion for this Organization';

function invalidSignedAssertion(cause?: unknown): AppError {
  return new AppError({
    code: 'INVALID_USER_IDENTITY',
    message: INVALID_SIGNED_ASSERTION_MESSAGE,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Signed mode: any verification failure. The message never says which check
 * failed.
 */
export function invalidSignedUserAssertion(cause?: unknown): AppError {
  recordRejected('auth');
  return invalidSignedAssertion(cause);
}

/** Unparsable Signed User Assertion payload; rejection accounting stays in the verifier. */
export function malformedUserAssertionPayload(cause: unknown): AppError {
  return invalidSignedAssertion(cause);
}

/** An identity-configuration store or JWKS outage; retryable, never a fallback. */
export function identityProviderUnavailable(
  cause?: unknown,
  retryAfterMs?: number,
): AppError {
  return new AppError({
    code: 'IDENTITY_PROVIDER_UNAVAILABLE',
    message: 'Identity provider is unavailable',
    retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(cause === undefined ? {} : { cause }),
  });
}
