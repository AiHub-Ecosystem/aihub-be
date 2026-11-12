/** How far either side of its base interval a recurring pass may land. */
export const JITTER_FRACTION = 0.1;

/** A delay drawn uniformly within ten percent either side of `baseMs`. */
export function jitteredDelayMs(
  baseMs: number,
  random: () => number = Math.random,
): number {
  return Math.floor(
    baseMs * (1 - JITTER_FRACTION + 2 * JITTER_FRACTION * random()),
  );
}

/** A random offset in `[0, windowMs)`. */
export function staggerMs(
  windowMs: number,
  random: () => number = Math.random,
): number {
  return Math.floor(random() * windowMs);
}

/**
 * A recurring in-process timer that re-arms itself after each tick instead of
 * firing on a fixed `setInterval` grid, so replicas booted together drift
 * apart rather than hitting the shared database in the same instant (#1869).
 *
 * The first tick lands anywhere within one base interval of `start()` unless
 * the caller passes its own first delay. Each later tick waits
 * `nextDelayMs()`: by default the base interval jittered ten percent either
 * way, or any schedule the caller supplies (quota reconciliation keeps its
 * interval boundaries this way).
 *
 * The next tick is armed as soon as `tick` returns, not when the work it
 * started settles, so a caller whose pass can outlast the interval keeps its
 * own single-flight guard. `tick` must not throw: like a `setInterval`
 * callback, a throw escapes as an uncaught exception. The timer is
 * unref'd and never holds the process open; `start()` is one-shot, and
 * `stop()` cancels the pending tick and arms no further one, including when
 * it is called from inside a tick. Awaiting an in-flight pass stays with the
 * caller, which owns the work.
 */
export class JitteredTimer {
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;

  constructor(
    private readonly tick: () => void,
    private readonly baseMs: number,
    private readonly nextDelayMs?: () => number,
    private readonly random: () => number = Math.random,
  ) {}

  start(firstDelayMs: number = staggerMs(this.baseMs, this.random)): void {
    if (this.started) return;
    this.started = true;
    this.arm(firstDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
      this.arm(
        this.nextDelayMs?.() ?? jitteredDelayMs(this.baseMs, this.random),
      );
    }, delayMs);
    this.timer.unref();
  }
}
