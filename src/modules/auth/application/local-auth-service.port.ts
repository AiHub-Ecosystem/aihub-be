import type {
  LoginRequest,
  RegisterRequest,
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
  login(
    input: LoginRequest,
    ip: string,
  ): Promise<{ readonly accessToken: string; readonly expiresIn: number }>;
}

export const LOCAL_AUTH_SERVICE = Symbol('LOCAL_AUTH_SERVICE');
