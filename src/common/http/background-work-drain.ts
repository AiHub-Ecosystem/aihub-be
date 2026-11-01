import { backgroundDrainMs, largestRequestTimeoutMs } from './shutdown-budget';

let pendingWork = 0;
let shuttingDown = false;
const drainWaiters = new Set<() => void>();

/**
 * Shutdown has begun: background loops start no new round, and a round already
 * running hands back what it has not started. It is set before the server
 * closes, so the drain below waits for work that is ending, not for work that
 * keeps being started. It is one-way and process-wide: a spec that needs it
 * clear loads a fresh copy of this module in a fresh test module registry.
 */
export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function backgroundWorkStarted(): void {
  pendingWork += 1;
}

export function backgroundWorkSettled(): void {
  if (pendingWork === 0) {
    return;
  }

  pendingWork -= 1;
  if (pendingWork === 0) {
    for (const resolve of drainWaiters) {
      resolve();
    }
    drainWaiters.clear();
  }
}

export function waitForBackgroundWork(): Promise<void> {
  if (pendingWork === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      clearTimeout(timer);
      drainWaiters.delete(finish);
      resolve();
    };

    drainWaiters.add(finish);
    // Sized for the slowest timed route in the catalog (ADR-0085 amendment).
    timer = setTimeout(() => {
      drainWaiters.delete(finish);
      reject(
        new Error('Background work did not drain before shutdown deadline'),
      );
    }, backgroundDrainMs(largestRequestTimeoutMs()));
  });
}
