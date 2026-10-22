import { jitteredRetryAfterMs } from '@/common/errors/retry-jitter';

import type { RateLimitDecision, RateLimitStanding } from './rate-limiter.port';
import { stableOffsetMs } from './stable-offset';

export const RATE_WINDOW_MS = 60_000;

export interface RateLimitWindow {
  /** The window's number, used in the counter key. */
  readonly index: number;
  /** Time until this key's window resets, in `(0, RATE_WINDOW_MS]`. */
  readonly resetInMs: number;
}

/**
 * Every API key keeps a fixed one-minute window, but each key's windows start
 * at its own offset into the minute, so keys do not all reset, and their
 * refused callers do not all return, at the top of the minute (#403).
 */
export function rateLimitWindow(keyId: string, now: number): RateLimitWindow {
  const shifted = now - stableOffsetMs(keyId, RATE_WINDOW_MS);
  const index = Math.floor(shifted / RATE_WINDOW_MS);
  return {
    index,
    resetInMs: (index + 1) * RATE_WINDOW_MS - shifted,
  };
}

/** What a key has left of its window after `count` requests in it. */
export function rateLimitStanding(
  limit: number,
  count: number,
  window: RateLimitWindow,
): RateLimitStanding {
  return {
    limit,
    remaining: Math.max(0, limit - count),
    resetInMs: window.resetInMs,
  };
}

/**
 * Admits the `count`-th request of a window up to `limit`. A refusal is told
 * to come back once the key's window resets, plus jitter.
 */
export function rateLimitDecision(
  limit: number,
  count: number,
  window: RateLimitWindow,
  random: () => number,
): RateLimitDecision {
  const standing = rateLimitStanding(limit, count, window);
  return count <= limit
    ? { allowed: true, standing }
    : {
        allowed: false,
        retryAfterMs: jitteredRetryAfterMs(window.resetInMs, random),
        standing,
      };
}
