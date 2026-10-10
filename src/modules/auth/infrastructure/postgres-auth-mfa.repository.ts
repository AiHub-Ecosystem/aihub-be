import type {
  AuthMfaFactorRecord,
  AuthMfaRepositoryPort,
} from '@/modules/auth/application/auth-mfa-repository.port';
import type {
  EmailDeliveryTransaction,
  InsertEmailDeliveryRequestInput,
} from '@/modules/auth/application/email-delivery-request.port';
import type {
  PostgresAuthClient,
  PostgresAuthQueryClient,
} from './postgres-auth.client';
import { PostgresEmailDeliveryRequestRepository } from './postgres-email-delivery-request.repository';
import { REVOKE_USER_WEB_SESSIONS_SQL } from './postgres-web-session.repository';

export class PostgresAuthMfaRepository implements AuthMfaRepositoryPort {
  constructor(
    private readonly client: PostgresAuthClient,
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
    return this.client.transaction(async (transaction) => {
      const accounts = await transaction.query(
        'SELECT status FROM user_accounts WHERE id = $1 FOR UPDATE',
        [input.userId],
      );
      if (accounts[0]?.['status'] !== 'active') return false;

      const identities = await transaction.query(
        `SELECT password_hash FROM auth_identities
         WHERE user_account_id = $1 AND provider = 'password' FOR UPDATE`,
        [input.userId],
      );
      if (identities[0]?.['password_hash'] !== input.expectedPasswordHash) {
        return false;
      }

      const existing = await transaction.query(
        'SELECT status FROM user_mfa_factors WHERE user_account_id = $1 FOR UPDATE',
        [input.userId],
      );
      if (existing[0]?.['status'] === 'enabled') return false;
      if (existing.length > 0) {
        await transaction.query(
          `UPDATE user_mfa_factors
           SET factor_id = $2, secret_key_id = $3, secret_ciphertext = $4,
               status = 'pending', updated_at = $5
           WHERE user_account_id = $1`,
          [
            input.userId,
            input.factorId,
            input.keyId,
            input.ciphertext,
            input.now,
          ],
        );
      } else {
        await transaction.query(
          `INSERT INTO user_mfa_factors (
             factor_id, user_account_id, secret_key_id, secret_ciphertext,
             status, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'pending', $5, $5)`,
          [
            input.factorId,
            input.userId,
            input.keyId,
            input.ciphertext,
            input.now,
          ],
        );
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
    return this.client.transaction(async (transaction) => {
      const accounts = await transaction.query(
        `SELECT status FROM user_accounts WHERE id = $1 FOR UPDATE`,
        [input.userId],
      );
      if (accounts[0]?.['status'] !== 'active') return false;
      const factors = await transaction.query(
        `SELECT factor_id FROM user_mfa_factors
         WHERE user_account_id = $1 AND status = 'pending' FOR UPDATE`,
        [input.userId],
      );
      if (factors[0]?.['factor_id'] !== input.factorId) return false;
      const identities = await transaction.query(
        `SELECT canonical_email FROM auth_identities
         WHERE user_account_id = $1 AND provider = 'password'`,
        [input.userId],
      );
      if (identities[0]?.['canonical_email'] !== input.email) return false;

      await transaction.query(
        `UPDATE user_mfa_factors SET status = 'enabled', updated_at = $2
         WHERE user_account_id = $1`,
        [input.userId, input.now],
      );
      await transaction.query(
        'DELETE FROM user_mfa_recovery_codes WHERE user_account_id = $1',
        [input.userId],
      );
      for (const codeHash of input.recoveryCodeHashes) {
        await transaction.query(
          `INSERT INTO user_mfa_recovery_codes (
             user_account_id, code_hash, created_at
           ) VALUES ($1, $2, $3)`,
          [input.userId, codeHash, input.now],
        );
      }
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
    return this.client.transaction(async (transaction) => {
      const accounts = await transaction.query(
        'SELECT status FROM user_accounts WHERE id = $1 FOR UPDATE',
        [input.userId],
      );
      if (accounts[0]?.['status'] !== 'active') return false;
      const identities = await transaction.query(
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
      const factors = await transaction.query(
        `SELECT factor_id FROM user_mfa_factors
         WHERE user_account_id = $1 AND status = 'enabled' FOR UPDATE`,
        [input.userId],
      );
      const factorId = factors[0]?.['factor_id'];
      if (factorId === undefined) return input.factorId === undefined;
      if (factorId !== input.factorId) return false;
      await transaction.query(
        'DELETE FROM user_mfa_factors WHERE user_account_id = $1',
        [input.userId],
      );
      await transaction.query(
        'DELETE FROM user_mfa_recovery_codes WHERE user_account_id = $1',
        [input.userId],
      );
      await transaction.query(
        `UPDATE refresh_tokens SET revoked_at = $2
         WHERE user_account_id = $1 AND revoked_at IS NULL`,
        [input.userId, input.now],
      );
      await transaction.query(REVOKE_USER_WEB_SESSIONS_SQL, [
        input.userId,
        input.now,
      ]);
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
    const rows = await this.client.query(
      `SELECT factor.factor_id, factor.secret_key_id, factor.secret_ciphertext,
              identity.canonical_email
       FROM user_mfa_factors factor
       JOIN user_accounts account ON account.id = factor.user_account_id
       JOIN auth_identities identity
         ON identity.user_account_id = factor.user_account_id
        AND identity.provider = 'password'
       WHERE factor.user_account_id = $1 AND factor.status = $2
         AND account.status = 'active'`,
      [userId, status],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    if (
      typeof row.factor_id !== 'string' ||
      typeof row.secret_key_id !== 'string' ||
      typeof row.secret_ciphertext !== 'string' ||
      typeof row.canonical_email !== 'string'
    ) {
      throw new Error('Auth MFA factor projection is invalid');
    }
    return {
      factorId: row.factor_id,
      userId,
      email: row.canonical_email,
      keyId: row.secret_key_id,
      ciphertext: row.secret_ciphertext,
    };
  }

  private async insertEmailDelivery(
    transaction: PostgresAuthQueryClient,
    input: InsertEmailDeliveryRequestInput,
  ): Promise<void> {
    await this.emailRequests.insert(
      transaction as PostgresAuthQueryClient & EmailDeliveryTransaction,
      input,
    );
  }
}
