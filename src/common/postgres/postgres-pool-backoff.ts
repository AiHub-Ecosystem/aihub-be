import type { PostgresBreakerState } from '@/common/observability/postgres-pool-resilience-metrics';

/**
 * Decorrelated jitter (#1608): each wait is drawn from `[base, previous * 3]`
 * and capped, so replicas that failed together drift apart instead of
 * retrying on the same schedule. The whole retry chain stays inside one
 * request's acquisition deadline, so the cap is far below a second.
 */
export const BACKOFF_BASE_MS = 10;
export const BACKOFF_CAP_MS = 100;

export function nextBackoffMs(
  previousMs: number,
  random: () => number = Math.random,
): number {
  const upper = Math.min(
    BACKOFF_CAP_MS,
    Math.max(previousMs, BACKOFF_BASE_MS) * 3,
  );
  return Math.floor(BACKOFF_BASE_MS + random() * (upper - BACKOFF_BASE_MS + 1));
}

/**
 * A connection error worth retrying: no SQLSTATE (socket error, timeout) or one
 * about the server being down, full, or dropping us. A rejected login or
 * another statement-level code would fail the same way again.
 */
export function isRetryableConnectError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  return !(
    typeof code === 'string' &&
    /^[0-9A-Z]{5}$/.test(code) &&
    !/^(08|53|57)/.test(code)
  );
}

/** Consecutive acquisition failures that trip the breaker. */
export const BREAKER_FAILURE_THRESHOLD = 5;
/** How long the breaker sheds before it lets one probe through. */
export const BREAKER_COOLDOWN_MS = 1_000;

/**
 * Sheds acquisitions once the pool stops handing out connections (#1608).
 * Closed → open after consecutive failures; after a jittered cooldown one
 * probe goes through (half-open) and its result closes or re-opens the
 * breaker. Without it every request would queue behind a dead database until
 * its own deadline, keeping a promise and a timer alive for each.
 */
export class PoolStarvationBreaker {
  private state: PostgresBreakerState = 'closed';
  private failures = 0;
  private reopenAt = 0;
  private probing = false;

  constructor(
    private readonly onChange: (state: PostgresBreakerState) => void,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  /** Whether a request may try to acquire a connection. */
  admit(): boolean {
    if (this.state === 'open') {
      if (this.now() < this.reopenAt) return false;
      this.enter('half_open');
    }
    if (this.state === 'half_open') {
      if (this.probing) return false;
      this.probing = true;
    }
    return true;
  }

  success(): void {
    this.failures = 0;
    this.probing = false;
    if (this.state !== 'closed') this.enter('closed');
  }

  /** Returns true when this failure opened the breaker. */
  failure(): boolean {
    if (this.state === 'open') return false;
    this.failures += 1;
    if (this.state === 'closed' && this.failures < BREAKER_FAILURE_THRESHOLD) {
      return false;
    }
    this.probing = false;
    this.reopenAt = this.now() + BREAKER_COOLDOWN_MS * (1 + this.random() / 2);
    this.enter('open');
    return true;
  }

  private enter(state: PostgresBreakerState): void {
    this.state = state;
    this.onChange(state);
  }
}
