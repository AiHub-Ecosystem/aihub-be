import type {
  ForgotPasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
} from '../../../contracts/auth/local-auth';

export interface LocalAuthServicePort {
  register(
    input: RegisterRequest,
    ip: string,
  ): Promise<{
    readonly email: string;
    readonly username: string;
    readonly status: 'pending_verification';
  }>;
  verify(token: string, ip: string): Promise<void>;
  resend(email: string, ip: string): Promise<void>;
  forgotPassword(
    input: ForgotPasswordRequest,
    ip: string,
  ): Promise<{ readonly message: string }>;
  resetPassword(input: ResetPasswordRequest, ip: string): Promise<void>;
  login(
    input: LoginRequest,
    ip: string,
  ): Promise<{
    readonly accessToken: string;
    readonly expiresIn: number;
    readonly refreshToken: string;
  }>;
  refresh(
    rawToken: string | undefined,
    ip: string,
  ): Promise<{
    readonly accessToken: string;
    readonly expiresIn: number;
    readonly refreshToken: string;
  }>;
  logout(rawToken: string | undefined): Promise<void>;
}

export class RefreshRotationCommittedError extends Error {
  constructor() {
    super('refresh rotation committed before access-token issuance');
    this.name = 'RefreshRotationCommittedError';
  }
}

export const LOCAL_AUTH_SERVICE = Symbol('LOCAL_AUTH_SERVICE');
