import type { RegisterRequest } from '../../../contracts/auth/local-auth';

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
}

export const LOCAL_AUTH_SERVICE = Symbol('LOCAL_AUTH_SERVICE');
