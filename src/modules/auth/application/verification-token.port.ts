export interface IssuedVerificationToken {
  readonly id: string;
  readonly raw: string;
  readonly hash: string;
  readonly expiresAt: Date;
}

export interface VerificationTokenPort {
  issue(now: Date): IssuedVerificationToken;
  hash(raw: string): string;
}

export const VERIFICATION_TOKEN = Symbol('VERIFICATION_TOKEN');
