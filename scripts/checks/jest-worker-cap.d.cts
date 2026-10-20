// Hand-written because the module it describes is plain CommonJS: Jest loads the
// lane config through it, so it must run before any TypeScript is compiled.
export interface WorkerResolution {
  maxWorkers: number;
  source: 'requested' | 'memory' | 'unknown';
  capped: boolean;
}
export declare const REQUEST_VARIABLE: 'AIHUB_JEST_MAX_WORKERS';
export declare const DEFAULT_MAX_WORKERS: 2;
export declare const BYTES_PER_WORKER: number;
export declare function resolveMaxWorkers(input?: {
  freeBytes?: number | undefined;
  requested?: string | number | null | undefined;
}): WorkerResolution;
export declare function resolveUnitLaneWorkers(input?: {
  env?: Record<string, string | undefined>;
  freeBytes?: number | undefined;
}): WorkerResolution;
