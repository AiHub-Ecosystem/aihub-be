import { performance } from 'node:perf_hooks';

export function safeDatabaseLaneErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.replace(
    /(?:postgres(?:ql)?|prisma\+postgres):\/\/[^\s"'`<>]+/gi,
    '<redacted database URL>',
  );
}

export async function timeDatabasePhase<T>(
  phase: string,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work();
  } catch (error) {
    throw new Error(`${phase} failed: ${safeDatabaseLaneErrorMessage(error)}`);
  } finally {
    console.info(
      `[db-lane] ${phase}: ${((performance.now() - startedAt) / 1_000).toFixed(2)}s`,
    );
  }
}
