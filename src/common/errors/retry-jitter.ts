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
