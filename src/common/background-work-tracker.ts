import { internalError } from './errors/app-error';
let pendingWork = 0;
const drainWaiters = new Set<() => void>();

export function backgroundWorkStarted(): void {
  pendingWork += 1;
}

export function backgroundWorkSettled(): void {
  if (pendingWork === 0) return;

  pendingWork -= 1;
  if (pendingWork === 0) {
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  }
}

export function waitForBackgroundWork(timeoutMs: number): Promise<void> {
  if (pendingWork === 0) return Promise.resolve();

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
        internalError('Background work did not drain before shutdown deadline'),
      );
    }, timeoutMs);
  });
}
