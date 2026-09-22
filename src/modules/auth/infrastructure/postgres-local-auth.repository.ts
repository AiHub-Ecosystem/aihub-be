import { ulid } from 'ulid';

import {
  AuthIdentityConflictError,
  type CreateRefreshSessionInput,
  type LocalAuthRepositoryPort,
  type LoginIdentity,
  type PasswordResetResult,
  type PasswordResetTarget,
  type PasswordResetTokenCheckResult,
  type RefreshTokenRecord,
  type RefreshTokenRotationResult,
  type RegisterLocalAccountInput,
  type ResendVerificationTarget,
  type RotateRefreshTokenInput,
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

type PasswordResetTokenInspection =
  | { readonly kind: 'valid'; readonly id: string; readonly userId: string }
  | {
      readonly kind: 'invalid';
      readonly reason: 'missing' | 'inactive' | 'expired' | 'consumed';
    };

function inspectPasswordResetToken(
  row: Record<string, unknown> | undefined,
  now: Date,
): PasswordResetTokenInspection {
  if (row === undefined) {
    return { kind: 'invalid', reason: 'missing' };
  }
  if (
    typeof row.id !== 'string' ||
    typeof row.user_account_id !== 'string' ||
    !(row.expires_at instanceof Date) ||
    Number.isNaN(row.expires_at.getTime()) ||
    (row.consumed_at !== null && !(row.consumed_at instanceof Date)) ||
    (row.consumed_at instanceof Date &&
      Number.isNaN(row.consumed_at.getTime())) ||
    (row.status !== 'pending_verification' &&
      row.status !== 'active' &&
      row.status !== 'disabled')
  ) {
    return { kind: 'invalid', reason: 'missing' };
  }
  if (row.status !== 'active') {
    return { kind: 'invalid', reason: 'inactive' };
  }
  if (row.consumed_at !== null) {
    return { kind: 'invalid', reason: 'consumed' };
  }
  if (row.expires_at.getTime() <= now.getTime()) {
    return { kind: 'invalid', reason: 'expired' };
  }
  return { kind: 'valid', id: row.id, userId: row.user_account_id };
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

  async issuePasswordResetToken(input: {
    readonly email: string;
    readonly tokenId: string;
    readonly tokenHash: string;
    readonly tokenExpiresAt: Date;
    readonly now: Date;
  }): Promise<PasswordResetTarget | undefined> {
    return this.client.transaction(async (transaction) => {
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
        row.status !== 'active' ||
        typeof row.id !== 'string' ||
        typeof row.canonical_email !== 'string'
      ) {
        return undefined;
      }

      await transaction.query(
        `
          UPDATE password_reset_tokens
          SET consumed_at = $2
          WHERE user_account_id = $1 AND consumed_at IS NULL
        `,
        [row.id, input.now],
      );
      await transaction.query(
        `
          INSERT INTO password_reset_tokens (
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

  async checkPasswordResetToken(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<PasswordResetTokenCheckResult> {
    const rows = await this.client.query(
      `
        SELECT token.id, token.user_account_id, token.expires_at,
               token.consumed_at, account.status
        FROM password_reset_tokens token
        JOIN user_accounts account ON account.id = token.user_account_id
        WHERE token.token_hash = $1
      `,
      [input.tokenHash],
    );
    const inspection = inspectPasswordResetToken(rows[0], input.now);
    return inspection.kind === 'valid' ? { kind: 'valid' } : inspection;
  }

  async consumePasswordReset(input: {
    readonly tokenHash: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<PasswordResetResult> {
    return this.client.transaction(async (transaction) => {
      const rows = await transaction.query(
        `
          SELECT token.id, token.user_account_id, token.expires_at,
                 token.consumed_at, account.status
          FROM password_reset_tokens token
          JOIN user_accounts account ON account.id = token.user_account_id
          WHERE token.token_hash = $1
          FOR UPDATE
        `,
        [input.tokenHash],
      );
      const inspection = inspectPasswordResetToken(rows[0], input.now);
      if (inspection.kind === 'invalid') {
        return inspection;
      }

      const identity = await transaction.query(
        `
          UPDATE auth_identities
          SET password_hash = $2, updated_at = $3
          WHERE user_account_id = $1 AND provider = 'password'
          RETURNING id
        `,
        [inspection.userId, input.passwordHash, input.now],
      );
      if (identity.length === 0) {
        throw new Error('local password identity is missing');
      }

      const consumed = await transaction.query(
        `
          UPDATE password_reset_tokens
          SET consumed_at = $2
          WHERE id = $1 AND consumed_at IS NULL
          RETURNING id
        `,
        [inspection.id, input.now],
      );
      if (consumed.length === 0) {
        throw new Error('password reset token was concurrently consumed');
      }
      await transaction.query(
        `
          UPDATE password_reset_tokens
          SET consumed_at = $2
          WHERE user_account_id = $1 AND consumed_at IS NULL
        `,
        [inspection.userId, input.now],
      );
      await transaction.query(
        `
          UPDATE refresh_tokens
          SET revoked_at = $2
          WHERE user_account_id = $1 AND revoked_at IS NULL
        `,
        [inspection.userId, input.now],
      );
      return { kind: 'reset' };
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

  async createRefreshSession(input: CreateRefreshSessionInput): Promise<void> {
    await this.client.query(
      `
        INSERT INTO refresh_tokens (
          id, family_id, user_account_id, token_hash, issued_at, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        input.token.id,
        input.token.familyId,
        input.userId,
        input.token.hash,
        input.issuedAt,
        input.token.expiresAt,
      ],
    );
  }

  async findRefreshTokenByHash(
    tokenHash: string,
  ): Promise<RefreshTokenRecord | undefined> {
    const rows = await this.client.query(
      `
        SELECT id AS token_id, family_id, user_account_id,
               expires_at, used_at, revoked_at
        FROM refresh_tokens
        WHERE token_hash = $1
      `,
      [tokenHash],
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return this.refreshTokenRecord(row);
  }

  async rotateRefreshToken(
    input: RotateRefreshTokenInput,
  ): Promise<RefreshTokenRotationResult> {
    return this.client.transaction(async (transaction) => {
      const rows = await transaction.query(
        `
          SELECT token.id AS token_id, token.family_id,
                 token.user_account_id, token.expires_at,
                 token.used_at, token.revoked_at, account.status
          FROM refresh_tokens token
          JOIN user_accounts account ON account.id = token.user_account_id
          WHERE token.id = $1 AND token.token_hash = $2
          FOR UPDATE
        `,
        [input.tokenId, input.tokenHash],
      );
      const row = rows[0];
      if (row === undefined) {
        return { kind: 'invalid', reason: 'missing' };
      }

      const record = this.refreshTokenRecord(row);
      if (record === undefined) {
        return { kind: 'invalid', reason: 'missing' };
      }
      if (row.status !== 'active') {
        return { kind: 'invalid', reason: 'inactive' };
      }
      if (record.revokedAt !== undefined) {
        await this.revokeFamily(transaction, record.familyId, input.now);
        return { kind: 'invalid', reason: 'revoked' };
      }
      if (record.usedAt !== undefined) {
        await this.revokeFamily(transaction, record.familyId, input.now);
        return { kind: 'invalid', reason: 'used' };
      }
      if (record.expiresAt.getTime() <= input.now.getTime()) {
        return { kind: 'invalid', reason: 'expired' };
      }

      await transaction.query(
        `
          UPDATE refresh_tokens
          SET used_at = $2
          WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
        `,
        [input.tokenId, input.now],
      );
      await transaction.query(
        `
          INSERT INTO refresh_tokens (
            id, family_id, user_account_id, token_hash, issued_at, expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          input.successor.id,
          input.successor.familyId,
          record.userId,
          input.successor.hash,
          input.now,
          input.successor.expiresAt,
        ],
      );
      return { kind: 'rotated', userId: record.userId };
    });
  }

  async revokeRefreshFamilyByTokenHash(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<void> {
    await this.client.transaction(async (transaction) => {
      const rows = await transaction.query(
        `
          SELECT family_id
          FROM refresh_tokens
          WHERE token_hash = $1
          FOR UPDATE
        `,
        [input.tokenHash],
      );
      const familyId = rows[0]?.family_id;
      if (typeof familyId !== 'string') {
        return;
      }
      await this.revokeFamily(transaction, familyId, input.now);
    });
  }

  private refreshTokenRecord(
    row: Record<string, unknown>,
  ): RefreshTokenRecord | undefined {
    if (
      typeof row.token_id !== 'string' ||
      typeof row.family_id !== 'string' ||
      typeof row.user_account_id !== 'string' ||
      !(row.expires_at instanceof Date) ||
      (row.used_at !== null && !(row.used_at instanceof Date)) ||
      (row.revoked_at !== null && !(row.revoked_at instanceof Date))
    ) {
      return undefined;
    }
    return {
      tokenId: row.token_id,
      familyId: row.family_id,
      userId: row.user_account_id,
      expiresAt: row.expires_at,
      usedAt: row.used_at === null ? undefined : row.used_at,
      revokedAt: row.revoked_at === null ? undefined : row.revoked_at,
    };
  }

  private async revokeFamily(
    transaction: PostgresAuthQueryClient,
    familyId: string,
    now: Date,
  ): Promise<void> {
    await transaction.query(
      `
        UPDATE refresh_tokens
        SET revoked_at = $2
        WHERE family_id = $1 AND revoked_at IS NULL
      `,
      [familyId, now],
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
