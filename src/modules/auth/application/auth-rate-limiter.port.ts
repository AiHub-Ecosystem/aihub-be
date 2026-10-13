export type AuthRateLimitScope =
  | 'register_ip'
  | 'resend_ip'
  | 'forgot_ip'
  | 'auth_email_request'
  | 'verify_ip'
  | 'web_session_verification_token'
  | 'login_ip'
  | 'login_email'
  | 'reset_ip'
  | 'reset_token'
  | 'refresh_ip'
  | 'refresh_token'
  | 'web_session_exchange_ip'
  | 'web_session_exchange_token'
  | 'organization_invitation_user'
  | 'organization_invitation_organization'
  | 'organization_invitation_email';

export interface AuthRateLimiterPort {
  consume(input: {
    readonly scope: AuthRateLimitScope;
    readonly key: string;
    readonly limit: number;
    readonly windowMs: number;
  }): Promise<{ readonly allowed: boolean; readonly retryAfterMs?: number }>;
}

export const AUTH_RATE_LIMITER = Symbol('AUTH_RATE_LIMITER');
