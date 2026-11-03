import type {
  ForgotPasswordRequest,
  ResetPasswordRequest,
} from '@/contracts/auth/local-auth';

export interface PasswordRecoveryPort {
  forgotPassword(
    input: ForgotPasswordRequest,
    ip: string,
  ): Promise<{ readonly message: string }>;
  resetPassword(input: ResetPasswordRequest, ip: string): Promise<void>;
}

export const PASSWORD_RECOVERY = Symbol('PASSWORD_RECOVERY');
