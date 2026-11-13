export const AUTH_SECURITY_EVENT_NAMES = [
  'refresh_reuse',
  'password_reset_completed',
  'login_succeeded',
  'login_failed',
  'verification_sign_in',
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
  | { readonly event: 'login_failed'; readonly userAccountId?: string };

export type AuthSecurityEvent = AuthSecurityEventDetails & {
  readonly occurredAt: Date;
};

export interface AuthSecurityEventRecorderPort {
  record(event: AuthSecurityEvent): void;
}

export const AUTH_SECURITY_EVENT_RECORDER = Symbol(
  'AUTH_SECURITY_EVENT_RECORDER',
);
