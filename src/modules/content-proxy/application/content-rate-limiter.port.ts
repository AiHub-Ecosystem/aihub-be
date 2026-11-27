export const CONTENT_RATE_LIMITER = Symbol('CONTENT_RATE_LIMITER');

export type ContentRateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

export interface ContentRateLimiterPort {
  consume(clientIp: string): Promise<ContentRateLimitDecision>;
}
