import { waitForBackgroundWork as waitForTrackedWork } from '@/common/background-work-tracker';
import { backgroundDrainMs, largestRequestTimeoutMs } from './shutdown-budget';

let shuttingDown = false;

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

export function waitForBackgroundWork(): Promise<void> {
  // Sized for the slowest timed route in the catalog (ADR-0085 amendment).
  return waitForTrackedWork(backgroundDrainMs(largestRequestTimeoutMs()));
}
