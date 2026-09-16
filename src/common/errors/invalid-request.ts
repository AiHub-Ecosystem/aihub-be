import { AppError } from './app-error';

/**
 * The rejection every boundary raises when a request fails its own schema.
 *
 * The message is deliberately uniform and says nothing about which field
 * failed: the shape of a rejected body is the caller's to inspect, and naming
 * the failing claim back to an unauthenticated caller tells them what to try
 * next.
 */
export function invalidRequest(cause?: unknown): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'Request failed validation',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}
