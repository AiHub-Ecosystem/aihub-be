const MAX_BACKGROUND_DRAIN_MS = 75_000;

let pendingWork = 0;
const drainWaiters = new Set<() => void>();

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
    timer = setTimeout(() => {
      drainWaiters.delete(finish);
      reject(
        new Error('Background work did not drain before shutdown deadline'),
      );
    }, MAX_BACKGROUND_DRAIN_MS);
  });
}
