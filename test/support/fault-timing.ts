import { getMetrics } from '@/common/observability/metrics/metrics';

/**
 * Fault-injection helpers that need no database or Redis, shared by the
 * tenant-isolation fault lane and the HTTP-only fault specs in the unit lane.
 */

/** A metric's current value from the exposition, or 0 before it is set. */
export async function metricValue(
  name: string,
  labels: Readonly<Record<string, string>>,
): Promise<number> {
  const labelText = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  const line = (await getMetrics())
    .split('\n')
    .find((candidate) => candidate.startsWith(`${name}{${labelText}} `));
  return line === undefined ? 0 : Number(line.slice(line.lastIndexOf(' ') + 1));
}

/** Milliseconds an async call took, with its outcome. */
export async function timed<T>(
  run: () => Promise<T>,
): Promise<{ readonly ms: number; readonly result: PromiseSettledResult<T> }> {
  const startedAt = performance.now();
  const [result] = await Promise.allSettled([run()]);
  return { ms: performance.now() - startedAt, result };
}

export function rejection(result: PromiseSettledResult<unknown>): unknown {
  if (result.status !== 'rejected') {
    throw new Error('Expected the call to fail during the fault');
  }
  return result.reason;
}

export async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Condition was not met after the fault cleared');
}
