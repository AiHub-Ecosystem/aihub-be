import type {
  CreateRefreshSessionInput,
  RefreshSessionRepositoryPort,
  RefreshTokenRecord,
  RefreshTokenRotationResult,
  RotateRefreshTokenInput,
} from '@/modules/auth/application/refresh-session-repository.port';
import { authorizeMfaSession } from './auth-mfa-session.guard';
import {
  type AuthRepositoryClient,
  type AuthTransactionClient,
  authQueryRows,
  authTransaction,
} from './auth-prisma';
import { insertRefreshSession } from './local-auth-statements';

/** The refresh token and its account's status, locked for rotation. */
const LOCK_REFRESH_TOKEN_SQL = `
  SELECT token.id,
         token.family_id AS "familyId",
         token.user_account_id AS "userAccountId",
         token.expires_at AS "expiresAt",
         token.used_at AS "usedAt",
         token.revoked_at AS "revokedAt",
         account.status
  FROM refresh_tokens token
  JOIN user_accounts account ON account.id = token.user_account_id
  WHERE token.id = $1 AND token.token_hash = $2
  FOR UPDATE
`;

interface RefreshTokenRow {
  readonly id: string;
  readonly familyId: string;
  readonly userAccountId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * One Refresh Session family (ADR-0024): creation, lookup, rotation, and
 * revocation. Rotation consumes the presented token and stores its successor
 * in one transaction, and a used or revoked token revokes its whole family.
 */
export class PostgresRefreshSessionRepository
  implements RefreshSessionRepositoryPort
{
  constructor(private readonly client: AuthRepositoryClient) {}

  async createRefreshSession(
    input: CreateRefreshSessionInput,
  ): Promise<boolean> {
    return authTransaction(this.client, async (transaction) => {
      const authorized = await authorizeMfaSession(
        transaction,
        input.userId,
        input.mfaProof,
        input.issuedAt,
      );
      if (!authorized) return false;
      await insertRefreshSession(transaction, input);
      return true;
    });
  }

  async findRefreshTokenByHash(
    tokenHash: string,
  ): Promise<RefreshTokenRecord | undefined> {
    const token = await this.client.refreshToken.findUnique({
      where: { tokenHash },
    });
    return token === null ? undefined : this.refreshTokenRecord(token);
  }

  async rotateRefreshToken(
    input: RotateRefreshTokenInput,
  ): Promise<RefreshTokenRotationResult> {
    return authTransaction(this.client, async (transaction) => {
      const rows = await authQueryRows<RefreshTokenRow & { status: string }>(
        transaction,
        LOCK_REFRESH_TOKEN_SQL,
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

      await transaction.refreshToken.updateMany({
        where: { id: input.tokenId, usedAt: null, revokedAt: null },
        data: { usedAt: input.now },
      });
      await insertRefreshSession(transaction, {
        userId: record.userId,
        token: input.successor,
        issuedAt: input.now,
      });
      return { kind: 'rotated', userId: record.userId };
    });
  }

  async revokeRefreshFamilyByTokenHash(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<void> {
    await authTransaction(this.client, async (transaction) => {
      const rows = await authQueryRows(
        transaction,
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

  private async revokeFamily(
    transaction: AuthTransactionClient,
    familyId: string,
    now: Date,
  ): Promise<void> {
    await transaction.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private refreshTokenRecord(
    row: RefreshTokenRow,
  ): RefreshTokenRecord | undefined {
    if (
      typeof row.id !== 'string' ||
      typeof row.familyId !== 'string' ||
      typeof row.userAccountId !== 'string' ||
      !(row.expiresAt instanceof Date) ||
      Number.isNaN(row.expiresAt.getTime()) ||
      (row.usedAt !== null && !(row.usedAt instanceof Date)) ||
      (row.revokedAt !== null && !(row.revokedAt instanceof Date))
    ) {
      return undefined;
    }
    return {
      tokenId: row.id,
      familyId: row.familyId,
      userId: row.userAccountId,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt === null ? undefined : row.usedAt,
      revokedAt: row.revokedAt === null ? undefined : row.revokedAt,
    };
  }
}
