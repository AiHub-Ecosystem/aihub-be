import { timingSafeEqual } from 'node:crypto';

/**
 * Compares a presented secret against the provisioned one without letting the
 * answer depend on how many leading bytes matched.
 *
 * `timingSafeEqual` refuses buffers of different lengths, so the length check
 * is the guard rather than a fast path: a caller that sends a different-length
 * secret gets `false` and never reaches the comparison, and the returned
 * answer says nothing about which side was short.
 */
export function constantTimeEquals(
  presented: string,
  expected: string,
): boolean {
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
