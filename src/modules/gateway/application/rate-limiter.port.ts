export interface RateLimitRequest {
  readonly keyId: string;
  readonly limit: number;
}

/** Where a key stands in its current window, for the `RateLimit` header fields. */
export interface RateLimitStanding {
  readonly limit: number;
  readonly remaining: number;
  readonly resetInMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs?: number;
  readonly standing?: RateLimitStanding;
}

export interface RateLimiterPort {
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');
