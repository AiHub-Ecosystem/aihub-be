export const AUTH_SECURITY_EVENT_NAMES = [
  'refresh_reuse',
  'password_reset_completed',
  'login_succeeded',
  'login_failed',
  'verification_sign_in',
  'web_session_created',
  'web_session_exchange_refused_unknown',
  'web_session_exchange_refused_expired',
  'web_session_exchange_refused_revoked',
  'web_session_exchange_refused_inactive_account',
  'web_session_revoked',
  'web_session_client_secret_guard_failed',
] as const;

export type AuthSecurityEventName = (typeof AUTH_SECURITY_EVENT_NAMES)[number];

type AuthSecurityEventDetails =
  | {
      readonly event:
        | 'refresh_reuse'
        | 'password_reset_completed'
        | 'login_succeeded'
        | 'verification_sign_in';
      readonly userAccountId: string;
    }
  | { readonly event: 'login_failed'; readonly userAccountId?: string }
  | {
      readonly event: 'web_session_created';
      readonly source: 'password_login' | 'verification_sign_in';
      readonly userAccountId: string;
    }
  | { readonly event: 'web_session_exchange_refused_unknown' }
  | {
      readonly event:
        | 'web_session_exchange_refused_expired'
        | 'web_session_exchange_refused_revoked'
        | 'web_session_exchange_refused_inactive_account';
      readonly userAccountId: string;
    }
  | {
      readonly event: 'web_session_revoked';
      readonly trigger: 'logout' | 'password_reset' | 'account_disabled';
      readonly sessionsRevoked: number;
      readonly userAccountId: string;
    }
  | { readonly event: 'web_session_client_secret_guard_failed' };

export type AuthSecurityEvent = AuthSecurityEventDetails & {
  readonly occurredAt: Date;
};

export interface AuthSecurityEventRecorderPort {
  record(event: AuthSecurityEvent): void;
}

export const AUTH_SECURITY_EVENT_RECORDER = Symbol(
  'AUTH_SECURITY_EVENT_RECORDER',
);
