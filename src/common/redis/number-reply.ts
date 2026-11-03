import { internalError } from '@/common/errors/app-error';
/** Narrows an `EVAL` reply a script promises to be one integer. */
export function numberReply(result: unknown): number {
  if (typeof result !== 'number') {
    throw internalError('Redis command result is invalid');
  }
  return result;
}
