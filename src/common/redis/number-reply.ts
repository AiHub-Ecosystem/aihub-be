/** Narrows an `EVAL` reply a script promises to be one integer. */
export function numberReply(result: unknown): number {
  if (typeof result !== 'number') {
    throw new Error('Redis command result is invalid');
  }
  return result;
}
