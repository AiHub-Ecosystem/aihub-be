export type AuthRateLimitScope =
  | 'register_ip'
  | 'register_email'
  | 'resend_ip'
  | 'resend_email'
  | 'verify_ip';

export interface AuthRateLimiterPort {
  consume(input: {
    readonly scope: AuthRateLimitScope;
    readonly key: string;
    readonly limit: number;
    readonly windowMs: number;
  }): Promise<{ readonly allowed: boolean; readonly retryAfterMs?: number }>;
}

export const AUTH_RATE_LIMITER = Symbol('AUTH_RATE_LIMITER');
