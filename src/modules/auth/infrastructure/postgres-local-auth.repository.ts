import { ulid } from 'ulid';

import {
  AuthIdentityConflictError,
  type LocalAuthRepositoryPort,
  type LoginIdentity,
  type RegisterLocalAccountInput,
  type ResendVerificationTarget,
} from '../application/local-auth-repository.port';
import type {
  PostgresAuthClient,
  PostgresAuthQueryClient,
} from './postgres-auth.client';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export class PostgresLocalAuthRepository implements LocalAuthRepositoryPort {
  constructor(private readonly client: PostgresAuthClient) {}

  async register(input: RegisterLocalAccountInput): Promise<void> {
    try {
      await this.client.transaction(async (transaction) => {
        const userId = `usr_${ulid()}`;
        await transaction.query(
          `
            INSERT INTO user_accounts (id, username, status, created_at, updated_at)
            VALUES ($1, $2, 'pending_verification', $3, $3)
          `,
          [userId, input.username, input.now],
        );
        await transaction.query(
          `
            INSERT INTO auth_identities (
              id, user_account_id, provider, canonical_email, password_hash,
              created_at, updated_at
            )
            VALUES ($1, $2, 'password', $3, $4, $5, $5)
          `,
          [
            `auth_${ulid()}`,
            userId,
            input.email,
            input.passwordHash,
            input.now,
          ],
        );
        await transaction.query(
          `
            INSERT INTO email_verification_tokens (
              id, user_account_id, token_hash, expires_at, created_at
            )
            VALUES ($1, $2, $3, $4, $5)
          `,
          [
            input.tokenId,
            userId,
            input.tokenHash,
            input.tokenExpiresAt,
            input.now,
          ],
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthIdentityConflictError();
      }
      throw error;
    }
  }

  async rotateVerificationToken(input: {
    readonly email: string;
    readonly tokenId: string;
    readonly tokenHash: string;
    readonly tokenExpiresAt: Date;
    readonly now: Date;
  }): Promise<ResendVerificationTarget | undefined> {
    try {
      return await this.client.transaction(async (transaction) => {
        const rows = await transaction.query(
          `
            SELECT ua.id, ai.canonical_email, ua.status
            FROM user_accounts ua
            JOIN auth_identities ai ON ai.user_account_id = ua.id
            WHERE ai.provider = 'password' AND ai.canonical_email = $1
            FOR UPDATE
          `,
          [input.email],
        );
        const row = rows[0];
        if (
          row === undefined ||
          row.status !== 'pending_verification' ||
          typeof row.id !== 'string' ||
          typeof row.canonical_email !== 'string'
        ) {
          return undefined;
        }

        await transaction.query(
          `
            UPDATE email_verification_tokens
            SET consumed_at = $2
            WHERE user_account_id = $1 AND consumed_at IS NULL
          `,
          [row.id, input.now],
        );
        await transaction.query(
          `
            INSERT INTO email_verification_tokens (
              id, user_account_id, token_hash, expires_at, created_at
            )
            VALUES ($1, $2, $3, $4, $5)
          `,
          [
            input.tokenId,
            row.id,
            input.tokenHash,
            input.tokenExpiresAt,
            input.now,
          ],
        );
        return { email: row.canonical_email };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthIdentityConflictError();
      }
      throw error;
    }
  }

  async consumeVerificationToken(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<boolean> {
    return this.client.transaction(async (transaction) => {
      const rows = await transaction.query(
        `
          UPDATE email_verification_tokens token
          SET consumed_at = $2
          FROM user_accounts account
          WHERE token.user_account_id = account.id
            AND token.token_hash = $1
            AND token.consumed_at IS NULL
            AND token.expires_at > $2
            AND account.status = 'pending_verification'
          RETURNING token.user_account_id
        `,
        [input.tokenHash, input.now],
      );
      const row = rows[0];
      if (row === undefined || typeof row.user_account_id !== 'string') {
        return false;
      }

      const activated = await transaction.query(
        `
          UPDATE user_accounts
          SET status = 'active', updated_at = $2
          WHERE id = $1 AND status = 'pending_verification'
          RETURNING id
        `,
        [row.user_account_id, input.now],
      );
      return activated.length > 0;
    });
  }

  async findLoginIdentityByEmail(
    email: string,
  ): Promise<LoginIdentity | undefined> {
    const rows = await this.client.query(
      `
        SELECT ua.id, ua.status, ai.password_hash
        FROM user_accounts ua
        JOIN auth_identities ai ON ai.user_account_id = ua.id
        WHERE ai.provider = 'password' AND ai.canonical_email = $1
      `,
      [email],
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    if (
      typeof row.id !== 'string' ||
      typeof row.password_hash !== 'string' ||
      (row.status !== 'pending_verification' &&
        row.status !== 'active' &&
        row.status !== 'disabled')
    ) {
      throw new Error('local auth identity projection is invalid');
    }
    return {
      userId: row.id,
      passwordHash: row.password_hash,
      status: row.status,
    };
  }

  async findUserAccountStatus(userId: string) {
    const rows = await this.client.query(
      'SELECT status FROM user_accounts WHERE id = $1',
      [userId],
    );
    const status = rows[0]?.status;
    if (status === undefined) {
      return undefined;
    }
    if (
      status !== 'pending_verification' &&
      status !== 'active' &&
      status !== 'disabled'
    ) {
      throw new Error('local account status projection is invalid');
    }
    return status;
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

export type AuthQueryClient = PostgresAuthQueryClient;
