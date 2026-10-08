import { AppError } from '@/common/errors/app-error';

/** A missing deployment secret or unavailable durable session store fails closed. */
export function webSessionUnavailable(cause: unknown): AppError {
  return new AppError({
    code: 'AUTH_WEB_SESSION_UNAVAILABLE',
    message: 'Web Sessions are temporarily unavailable',
    retryable: true,
    cause,
  });
}
