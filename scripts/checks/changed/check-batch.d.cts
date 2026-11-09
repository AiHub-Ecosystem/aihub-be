export const BATCHED_GATES: readonly string[];
export const MAX_CONCURRENCY: number;
export const BYTES_PER_CHILD: number;
export function concurrencyFor(options?: { freeBytes?: number }): number;
export type RunBatchOptions = {
  gates?: string[];
  freeBytes?: number;
  run?: (
    gate: string,
  ) => Promise<{ code?: number; output?: string } | null | undefined>;
  log?: (line: string) => void;
  error?: (line: string) => void;
};
export type BatchResult = {
  readonly exitCode: number;
  readonly concurrency: number;
  readonly peakInFlight: number;
  readonly failed: string[];
};
export function runBatch(options?: RunBatchOptions): Promise<BatchResult>;
