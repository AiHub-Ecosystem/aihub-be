import type { UserAccessSession } from '@/modules/auth/web-sessions/application/user-access-token.port';

export interface PasswordChangePort {
  change(input: {
    readonly userId: string;
    readonly session: UserAccessSession | undefined;
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly ip: string;
  }): Promise<void>;
}

export const PASSWORD_CHANGE = Symbol('PASSWORD_CHANGE');
