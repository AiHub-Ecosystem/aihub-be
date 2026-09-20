export type AuthRateLimitScope =
  | 'register_ip'
  | 'register_email'
  | 'resend_ip'
  | 'resend_email'
  | 'forgot_ip'
  | 'forgot_email'
  | 'verify_ip'
  | 'login_ip'
  | 'login_email'
  | 'reset_ip'
  | 'reset_token'
  | 'refresh_ip'
  | 'refresh_token';

export interface AuthRateLimiterPort {
  consume(input: {
    readonly scope: AuthRateLimitScope;
    readonly key: string;
    readonly limit: number;
    readonly windowMs: number;
  }): Promise<{ readonly allowed: boolean; readonly retryAfterMs?: number }>;
}

export const AUTH_RATE_LIMITER = Symbol('AUTH_RATE_LIMITER');
