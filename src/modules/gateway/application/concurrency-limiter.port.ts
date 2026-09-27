export interface ConcurrencyRequest {
  readonly organizationId: string;
  readonly maxConcurrent: number;
  readonly requestId: string;
  readonly environment?: string;
}

export interface ConcurrencyLease {
  release(): Promise<void>;
}

export type ConcurrencyDecision =
  | { readonly allowed: true; readonly lease: ConcurrencyLease }
  | { readonly allowed: false; readonly retryAfterMs: number };

export interface ConcurrencyLimiterPort {
  acquire(request: ConcurrencyRequest): Promise<ConcurrencyDecision>;
}

export const CONCURRENCY_LIMITER = Symbol('CONCURRENCY_LIMITER');
