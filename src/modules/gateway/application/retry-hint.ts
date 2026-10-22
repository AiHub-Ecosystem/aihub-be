import { createHash } from 'node:crypto';

/**
 * The spread added to a refusal's wait, so callers refused together are not
 * all told to come back at the same instant (#403). It is added on top of the
 * wait, never taken off it, so a hint is never earlier than the refusal clears.
 */
export const RETRY_HINT_JITTER_MS = 1_000;

export function jitteredRetryAfterMs(
  waitMs: number,
  random: () => number,
  spreadMs: number = RETRY_HINT_JITTER_MS,
): number {
  return waitMs + Math.floor(random() * spreadMs);
}

/**
 * A fixed offset in `[0, rangeMs)` derived from an id. The same id always gets
 * the same offset, so a key's window, or an Organization's rollover hint, stays
 * stable while different ids spread across the range.
 */
export function stableOffsetMs(id: string, rangeMs: number): number {
  return createHash('sha256').update(id).digest().readUInt32BE(0) % rangeMs;
}
