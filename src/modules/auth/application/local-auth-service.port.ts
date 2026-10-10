import type {
  ForgotPasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
} from '@/contracts/auth/local-auth';
export type LoginOutcome =
  | { readonly kind: 'session'; readonly session: IssuedSession }
  | { readonly kind: 'mfa-required' };

export interface IssuedSession {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
}

export interface LocalAuthServicePort {
  currentUser(userId: string): Promise<{ readonly username: string }>;
  register(
    input: RegisterRequest,
    ip: string,
    browserBinding?: string,
  ): Promise<{
    readonly email: string;
    readonly username: string;
    readonly status: 'pending_verification';
    readonly emailDeliveryStatus: 'queued';
  }>;
  /** Returns a session only for a Verification Sign-in (ADR-0054). */
  verify(
    token: string,
    ip: string,
    browserBinding?: string,
  ): Promise<IssuedSession | undefined>;
  resend(email: string, ip: string, browserBinding?: string): Promise<void>;
  forgotPassword(
    input: ForgotPasswordRequest,
    ip: string,
  ): Promise<{ readonly message: string }>;
  resetPassword(input: ResetPasswordRequest, ip: string): Promise<void>;
  login(input: LoginRequest, ip: string): Promise<LoginOutcome>;
  refresh(rawToken: string | undefined, ip: string): Promise<IssuedSession>;
  logout(rawToken: string | undefined): Promise<void>;
}

export class RefreshRotationCommittedError extends Error {
  constructor() {
    super('refresh rotation committed before access-token issuance');
    this.name = 'RefreshRotationCommittedError';
  }
}

export const LOCAL_AUTH_SERVICE = Symbol('LOCAL_AUTH_SERVICE');
