import { timeoutError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';

/**
 * The one deadline check: throws once the request is aborted or its deadline
 * has passed, otherwise returns the milliseconds still available.
 */
export function requireTimeLeft(context: RequestContext): number {
  const remainingMs = context.deadlineAt.getTime() - Date.now();
  if (context.signal.aborted || remainingMs <= 0) {
    throw timeoutError();
  }
  return remainingMs;
}
