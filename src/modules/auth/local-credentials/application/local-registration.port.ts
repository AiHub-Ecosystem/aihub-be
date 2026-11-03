import type { RegisterRequest } from '@/contracts/auth/local-auth';
import type { IssuedSession } from './session-token-issuers';

export interface RegisteredLocalAccount {
  readonly email: string;
  readonly username: string;
  readonly status: 'pending_verification';
  /** Acceptance-time only: the request is queued, not yet with the provider. */
  readonly emailDeliveryStatus: 'queued' | 'suppressed';
}

export interface LocalRegistrationPort {
  register(
    input: RegisterRequest,
    ip: string,
    browserBinding?: string,
  ): Promise<RegisteredLocalAccount>;
  /** Returns a session only for a Verification Sign-in (ADR-0054). */
  verify(
    token: string,
    ip: string,
    browserBinding?: string,
    /** The registration password, for a token that needs it (ADR-0123). */
    password?: string,
  ): Promise<IssuedSession | undefined>;
  resend(email: string, ip: string, browserBinding?: string): Promise<void>;
}

export const LOCAL_REGISTRATION = Symbol('LOCAL_REGISTRATION');
