import { AppError } from './app-error';

/**
 * The rejection every boundary raises when a request fails its own schema.
 *
 * The message is deliberately uniform and says nothing about which field
 * failed for an unauthenticated caller: the shape of a rejected body is the
 * caller's to inspect, and naming the failing claim back to an unauthenticated
 * caller tells them what to try next. Authenticated callers (API key or User
 * Access JWT) receive the failing paths and reasons in `details`.
 *
 * Failing paths are always recorded in `diagnostic` for the operator log.
 */
export function invalidRequest(
  cause?: unknown,
  details?: Readonly<Record<string, unknown>>,
  diagnostic?: string,
): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'Request failed validation',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
    ...(details === undefined ? {} : { details }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  });
}
