import { AppError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';

export function dispatchTimedOut(): AppError {
  return new AppError({
    code: 'AI_SERVICE_TIMEOUT',
    message: 'AI service request timed out',
    retryable: true,
  });
}

/**
 * The one deadline check: throws once the request is aborted or its deadline
 * has passed, otherwise returns the milliseconds still available.
 */
export function requireTimeLeft(context: RequestContext): number {
  const remainingMs = context.deadlineAt.getTime() - Date.now();
  if (context.signal.aborted || remainingMs <= 0) {
    throw dispatchTimedOut();
  }
  return remainingMs;
}
