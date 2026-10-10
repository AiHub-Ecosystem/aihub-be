import type { InsertEmailDeliveryRequestInput } from '@/modules/auth/application/email-delivery-request.port';
import type { RefreshTokenRecord } from '@/modules/auth/application/refresh-session-repository.port';
import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';

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

export interface InMemoryWebSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  /**
   * Mutable because renewal is an update, not a replacement: the adapter moves
   * it forward exactly as the conditional `UPDATE` does, and a test that
   * arranges a revoked or already-renewed session assigns `revokedAt` the same
   * way the store would.
   */
  expiresAt: Date;
  lastRenewedAt: Date;
  revokedAt: Date | undefined;
}

export interface InMemoryMfaFactor {
  readonly factorId: string;
  status: 'pending' | 'enabled';
  readonly email: string;
  readonly secret: string;
}

/**
 * The durable auth state one test owns. The in-memory adapters read and write
 * the same instance, so a cross-aggregate effect such as a password reset
 * revoking Refresh Sessions is observable without leaking into the next test.
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
  /** Token hash -> web session. */
  readonly webSessions: Map<string, InMemoryWebSession>;
  readonly mfaFactors: Map<string, InMemoryMfaFactor>;
  readonly recoveryCodes: Map<string, Set<string>>;
  /** Email Delivery Requests recorded by the adapters, in call order. */
  readonly emailDeliveryRequests: InsertEmailDeliveryRequestInput[];
  /** Empties the durable state so the next test starts from nothing. */
  reset(): void;
}

export function createInMemoryAuthState(): InMemoryAuthState {
  return {
    accounts: new Map(),
    verificationTokens: new Map(),
    passwordResetTokens: new Map(),
    refreshTokens: new Map(),
    webSessions: new Map(),
    mfaFactors: new Map(),
    recoveryCodes: new Map(),
    emailDeliveryRequests: [],
    reset() {
      this.accounts.clear();
      this.verificationTokens.clear();
      this.passwordResetTokens.clear();
      this.refreshTokens.clear();
      this.webSessions.clear();
      this.mfaFactors.clear();
      this.recoveryCodes.clear();
      this.emailDeliveryRequests.length = 0;
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
