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
 * The base wait of a refusal caused by a dependency outage or a full local
 * capacity ceiling (#1352): PostgreSQL, Redis, object storage, Argon2, the
 * Speaking upload ceiling. Its hint lands in `[1000, 2000)` ms.
 */
export const OUTAGE_RETRY_AFTER_MS = 1_000;

/**
 * The hint such a refusal carries. Without a spread every refused caller would
 * return together, and the first wave after recovery would land on a
 * dependency whose pools and caches are still cold. `waitMs` is the floor: a
 * longer remaining cooldown replaces the base, never the other way round.
 */
export function outageRetryAfterMs(
  random: () => number = Math.random,
  waitMs: number = OUTAGE_RETRY_AFTER_MS,
): number {
  return jitteredRetryAfterMs(Math.max(waitMs, 0), random);
}
