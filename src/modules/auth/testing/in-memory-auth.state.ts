import type { RefreshTokenRecord } from '../application/refresh-session-repository.port';
import type { LocalAccountStatus } from '../domain/local-auth';

export interface InMemoryAccount {
  readonly userId: string;
  readonly username: string;
  readonly email: string;
  status: LocalAccountStatus;
  passwordHash: string;
}

export interface InMemoryVerificationToken {
  readonly tokenId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly browserBindingHash: string | undefined;
  consumedAt: Date | undefined;
  consumedReason: 'verified' | 'superseded' | undefined;
  signedInAt: Date | undefined;
}

export interface InMemoryPasswordResetToken {
  readonly tokenId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  consumedAt: Date | undefined;
}

/**
 * The durable auth state one test owns. The four in-memory adapters read and
 * write the same instance, so a cross-aggregate effect such as a password
 * reset revoking Refresh Sessions is observable without leaking into the
 * next test.
 */
export interface InMemoryAuthState {
  /** User id -> account. */
  readonly accounts: Map<string, InMemoryAccount>;
  /** Token hash -> verification token. */
  readonly verificationTokens: Map<string, InMemoryVerificationToken>;
  /** Token hash -> password reset token. */
  readonly passwordResetTokens: Map<string, InMemoryPasswordResetToken>;
  /** Token hash -> refresh session token. */
  readonly refreshTokens: Map<string, RefreshTokenRecord>;
  /** Empties the durable state so the next test starts from nothing. */
  reset(): void;
}

export function createInMemoryAuthState(): InMemoryAuthState {
  return {
    accounts: new Map(),
    verificationTokens: new Map(),
    passwordResetTokens: new Map(),
    refreshTokens: new Map(),
    reset() {
      this.accounts.clear();
      this.verificationTokens.clear();
      this.passwordResetTokens.clear();
      this.refreshTokens.clear();
    },
  };
}

/** Adds or replaces an account, for a test that starts from a known login. */
export function seedAccount(
  state: InMemoryAuthState,
  account: {
    readonly userId: string;
    readonly email: string;
    readonly username?: string;
    readonly passwordHash: string;
    readonly status?: LocalAccountStatus;
  },
): InMemoryAccount {
  const seeded: InMemoryAccount = {
    userId: account.userId,
    username: account.username ?? `user_${account.userId}`,
    email: account.email,
    status: account.status ?? 'active',
    passwordHash: account.passwordHash,
  };
  state.accounts.set(seeded.userId, seeded);
  return seeded;
}
