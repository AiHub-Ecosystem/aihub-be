export interface RateLimitRequest {
  readonly keyId: string;
  readonly limit: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs?: number;
}

export interface RateLimiterPort {
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');
