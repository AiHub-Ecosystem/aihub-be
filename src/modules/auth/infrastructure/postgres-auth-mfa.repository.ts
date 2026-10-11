import type {
  AuthMfaFactorRecord,
  AuthMfaRepositoryPort,
} from '@/modules/auth/application/auth-mfa-repository.port';
import type {
  EmailDeliveryTransaction,
  InsertEmailDeliveryRequestInput,
} from '@/modules/auth/application/email-delivery-request.port';
import {
  type AuthRepositoryClient,
  type AuthTransactionClient,
  authQueryRows,
  authTransaction,
} from './auth-prisma';
import { PostgresEmailDeliveryRequestRepository } from './postgres-email-delivery-request.repository';
import { revokeUserWebSessions } from './web-session-statements';

export class PostgresAuthMfaRepository implements AuthMfaRepositoryPort {
  constructor(
    private readonly client: AuthRepositoryClient,
    private readonly emailRequests = new PostgresEmailDeliveryRequestRepository(),
  ) {}

  async findActiveFactor(
    userId: string,
  ): Promise<AuthMfaFactorRecord | undefined> {
    return this.findFactor(userId, 'enabled');
  }

  async findPendingFactor(
    userId: string,
  ): Promise<AuthMfaFactorRecord | undefined> {
    return this.findFactor(userId, 'pending');
  }

  async savePendingFactor(input: {
    readonly factorId: string;
    readonly userId: string;
    readonly expectedPasswordHash: string;
    readonly keyId: string;
    readonly ciphertext: string;
    readonly now: Date;
  }): Promise<boolean> {
    return authTransaction(this.client, async (transaction) => {
      const accounts = await authQueryRows(
        transaction,
        'SELECT status FROM user_accounts WHERE id = $1 FOR UPDATE',
        [input.userId],
      );
      if (accounts[0]?.['status'] !== 'active') return false;

      const identities = await authQueryRows(
        transaction,
        `SELECT password_hash FROM auth_identities
         WHERE user_account_id = $1 AND provider = 'password' FOR UPDATE`,
        [input.userId],
      );
      if (identities[0]?.['password_hash'] !== input.expectedPasswordHash) {
        return false;
      }

      const existing = await authQueryRows(
        transaction,
        'SELECT status FROM user_mfa_factors WHERE user_account_id = $1 FOR UPDATE',
        [input.userId],
      );
      if (existing[0]?.['status'] === 'enabled') return false;
      if (existing.length > 0) {
        await transaction.userMfaFactor.updateMany({
          where: { userAccountId: input.userId },
          data: {
            factorId: input.factorId,
            secretKeyId: input.keyId,
            secretCiphertext: input.ciphertext,
            status: 'pending',
            updatedAt: input.now,
          },
        });
      } else {
        await transaction.userMfaFactor.create({
          data: {
            factorId: input.factorId,
            userAccountId: input.userId,
            secretKeyId: input.keyId,
            secretCiphertext: input.ciphertext,
            status: 'pending',
            createdAt: input.now,
            updatedAt: input.now,
          },
        });
      }
      return true;
    });
  }

  async confirmFactor(input: {
    readonly factorId: string;
    readonly userId: string;
    readonly email: string;
    readonly recoveryCodeHashes: readonly string[];
    readonly emailDelivery: InsertEmailDeliveryRequestInput;
    readonly now: Date;
  }): Promise<boolean> {
    return authTransaction(this.client, async (transaction) => {
      const accounts = await authQueryRows(
        transaction,
        `SELECT status FROM user_accounts WHERE id = $1 FOR UPDATE`,
        [input.userId],
      );
      if (accounts[0]?.['status'] !== 'active') return false;
      const factors = await authQueryRows(
        transaction,
        `SELECT factor_id FROM user_mfa_factors
         WHERE user_account_id = $1 AND status = 'pending' FOR UPDATE`,
        [input.userId],
      );
      if (factors[0]?.['factor_id'] !== input.factorId) return false;
      const identity = await transaction.authIdentity.findFirst({
        where: { userAccountId: input.userId, provider: 'password' },
        select: { canonicalEmail: true },
      });
      if (identity?.canonicalEmail !== input.email) return false;

      await transaction.userMfaFactor.updateMany({
        where: { userAccountId: input.userId },
        data: { status: 'enabled', updatedAt: input.now },
      });
      await transaction.userMfaRecoveryCode.deleteMany({
        where: { userAccountId: input.userId },
      });
      await transaction.userMfaRecoveryCode.createMany({
        data: input.recoveryCodeHashes.map((codeHash) => ({
          userAccountId: input.userId,
          codeHash,
          createdAt: input.now,
        })),
      });
      await this.insertEmailDelivery(transaction, input.emailDelivery);
      return true;
    });
  }

  async removeFactor(input: {
    readonly factorId: string | undefined;
    readonly userId: string;
    readonly email: string;
    readonly expectedPasswordHash?: string;
    readonly emailDelivery: InsertEmailDeliveryRequestInput | undefined;
    readonly now: Date;
  }): Promise<boolean> {
    return authTransaction(this.client, async (transaction) => {
      const accounts = await authQueryRows(
        transaction,
        'SELECT status FROM user_accounts WHERE id = $1 FOR UPDATE',
        [input.userId],
      );
      if (accounts[0]?.['status'] !== 'active') return false;
      const identities = await authQueryRows(
        transaction,
        `SELECT canonical_email, password_hash FROM auth_identities
         WHERE user_account_id = $1 AND provider = 'password' FOR UPDATE`,
        [input.userId],
      );
      if (
        identities[0]?.['canonical_email'] !== input.email ||
        (input.expectedPasswordHash !== undefined &&
          identities[0]?.['password_hash'] !== input.expectedPasswordHash)
      ) {
        return false;
      }
      const factors = await authQueryRows(
        transaction,
        `SELECT factor_id FROM user_mfa_factors
         WHERE user_account_id = $1 AND status = 'enabled' FOR UPDATE`,
        [input.userId],
      );
      const factorId = factors[0]?.['factor_id'];
      if (factorId === undefined) return input.factorId === undefined;
      if (factorId !== input.factorId) return false;
      await transaction.userMfaFactor.deleteMany({
        where: { userAccountId: input.userId },
      });
      await transaction.userMfaRecoveryCode.deleteMany({
        where: { userAccountId: input.userId },
      });
      await transaction.refreshToken.updateMany({
        where: { userAccountId: input.userId, revokedAt: null },
        data: { revokedAt: input.now },
      });
      await revokeUserWebSessions(transaction, input.userId, input.now);
      if (input.emailDelivery !== undefined) {
        await this.insertEmailDelivery(transaction, input.emailDelivery);
      }
      return true;
    });
  }

  private async findFactor(
    userId: string,
    status: 'pending' | 'enabled',
  ): Promise<AuthMfaFactorRecord | undefined> {
    // An active account with a password identity, or no factor at all.
    const factor = await this.client.userMfaFactor.findFirst({
      where: {
        userAccountId: userId,
        status,
        userAccount: {
          status: 'active',
          authIdentities: { some: { provider: 'password' } },
        },
      },
      select: {
        factorId: true,
        secretKeyId: true,
        secretCiphertext: true,
        userAccount: {
          select: {
            authIdentities: {
              where: { provider: 'password' },
              select: { canonicalEmail: true },
              take: 1,
            },
          },
        },
      },
    });
    if (factor === null) return undefined;
    const email = factor.userAccount.authIdentities[0]?.canonicalEmail;
    if (email === undefined) {
      throw new Error('Auth MFA factor projection is invalid');
    }
    return {
      factorId: factor.factorId,
      userId,
      email,
      keyId: factor.secretKeyId,
      ciphertext: factor.secretCiphertext,
    };
  }

  private async insertEmailDelivery(
    transaction: AuthTransactionClient,
    input: InsertEmailDeliveryRequestInput,
  ): Promise<void> {
    await this.emailRequests.insert(
      transaction as unknown as EmailDeliveryTransaction,
      input,
    );
  }
}
