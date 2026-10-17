export interface IssuedPasswordResetToken {
  readonly id: string;
  readonly raw: string;
  readonly hash: string;
  readonly expiresAt: Date;
}

export interface PasswordResetTokenPort {
  issue(now: Date): IssuedPasswordResetToken;
  hash(raw: string): string;
}

export const PASSWORD_RESET_TOKEN = Symbol('PASSWORD_RESET_TOKEN');
