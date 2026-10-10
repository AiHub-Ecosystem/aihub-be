import type {
  AuthMfaFactorRecord,
  AuthMfaRepositoryPort,
} from '@/modules/auth/application/auth-mfa-repository.port';
import type { InsertEmailDeliveryRequestInput } from '@/modules/auth/application/email-delivery-request.port';
import type { InMemoryAuthState } from './in-memory-auth.state';

export class InMemoryAuthMfaAdapter implements AuthMfaRepositoryPort {
  constructor(private readonly state: InMemoryAuthState) {}

  async findActiveFactor(
    userId: string,
  ): Promise<AuthMfaFactorRecord | undefined> {
    const factor = this.state.mfaFactors.get(userId);
    return factor?.status === 'enabled'
      ? {
          factorId: factor.factorId,
          userId,
          email: factor.email,
          keyId: 'memory',
          ciphertext: factor.secret,
        }
      : undefined;
  }

  async findPendingFactor(
    userId: string,
  ): Promise<AuthMfaFactorRecord | undefined> {
    const factor = this.state.mfaFactors.get(userId);
    return factor?.status === 'pending'
      ? {
          factorId: factor.factorId,
          userId,
          email: factor.email,
          keyId: 'memory',
          ciphertext: factor.secret,
        }
      : undefined;
  }

  async savePendingFactor(input: {
    readonly factorId: string;
    readonly userId: string;
    readonly expectedPasswordHash: string;
    readonly keyId: string;
    readonly ciphertext: string;
    readonly now: Date;
  }): Promise<boolean> {
    const account = this.state.accounts.get(input.userId);
    if (
      account?.status !== 'active' ||
      account.passwordHash !== input.expectedPasswordHash
    )
      return false;
    if (this.state.mfaFactors.get(input.userId)?.status === 'enabled')
      return false;
    this.state.mfaFactors.set(input.userId, {
      factorId: input.factorId,
      status: 'pending',
      email: account.email,
      secret: input.ciphertext,
    });
    return true;
  }

  async confirmFactor(input: {
    readonly factorId: string;
    readonly userId: string;
    readonly email: string;
    readonly recoveryCodeHashes: readonly string[];
    readonly emailDelivery: InsertEmailDeliveryRequestInput;
    readonly now: Date;
  }): Promise<boolean> {
    const account = this.state.accounts.get(input.userId);
    const factor = this.state.mfaFactors.get(input.userId);
    if (
      account?.status !== 'active' ||
      account.email !== input.email ||
      factor?.status !== 'pending' ||
      factor.factorId !== input.factorId
    ) {
      return false;
    }
    factor.status = 'enabled';
    this.state.recoveryCodes.set(
      input.userId,
      new Set(input.recoveryCodeHashes),
    );
    this.state.emailDeliveryRequests.push(input.emailDelivery);
    return true;
  }

  async removeFactor(input: {
    readonly factorId: string | undefined;
    readonly userId: string;
    readonly email: string;
    readonly expectedPasswordHash?: string;
    readonly emailDelivery: InsertEmailDeliveryRequestInput | undefined;
    readonly now: Date;
  }): Promise<boolean> {
    const account = this.state.accounts.get(input.userId);
    if (
      account?.status !== 'active' ||
      account.email !== input.email ||
      (input.expectedPasswordHash !== undefined &&
        account.passwordHash !== input.expectedPasswordHash)
    ) {
      return false;
    }
    const factor = this.state.mfaFactors.get(input.userId);
    if (factor === undefined) return input.factorId === undefined;
    if (factor.status !== 'enabled' || factor.factorId !== input.factorId) {
      return false;
    }
    this.state.mfaFactors.delete(input.userId);
    this.state.recoveryCodes.delete(input.userId);
    for (const [hash, session] of this.state.refreshTokens) {
      if (session.userId === input.userId && session.revokedAt === undefined) {
        this.state.refreshTokens.set(hash, {
          ...session,
          revokedAt: input.now,
        });
      }
    }
    for (const session of this.state.webSessions.values()) {
      if (session.userId === input.userId && session.revokedAt === undefined) {
        session.revokedAt = input.now;
      }
    }
    if (input.emailDelivery !== undefined) {
      this.state.emailDeliveryRequests.push(input.emailDelivery);
    }
    return true;
  }
}
