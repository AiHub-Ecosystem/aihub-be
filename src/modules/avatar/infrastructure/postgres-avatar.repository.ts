import { AppError, internalError } from '@/common/errors/app-error';
import { postgresTimeoutKind } from '@/common/postgres/postgres-timeout-error';
import { databaseUnavailableError } from '@/common/postgres/postgres-unavailable-error';
import type {
  AvatarRepositoryPort,
  AvatarUploadGrantRecord,
  RecordAvatarResult,
} from '@/modules/avatar/application/avatar-repository.port';
import {
  AVATAR_COMPLETION_LOCK_TRANSACTION_TIMEOUT_MS,
  AVATAR_LOCK_IDLE_TRANSACTION_TIMEOUT_MS,
} from '@/modules/avatar/application/avatar-upload.policy';
import {
  type Avatar,
  isAvatarContentType,
} from '@/modules/avatar/domain/avatar';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import type { Prisma, PrismaClient, UserAvatar } from '@prisma-client/client';

export { createAvatarQueryClient } from './postgres-avatar.fixture-client';

// The unique constraint on the account is what keeps one Avatar per account,
// including under two concurrent completions. The conflict target has to stay
// `(user_account_id)`: a collision on the asset id or the object key is a bug
// to surface, and `createMany({ skipDuplicates })` would swallow it.
const INSERT_SQL = `
  INSERT INTO user_avatars
    (id, user_account_id, object_key, content_type, byte_size, accepted_at)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (user_account_id) DO NOTHING
  RETURNING id
`;
const AVATAR_USER_LOCK_SQL =
  'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const AVATAR_IDLE_TIMEOUT_SQL =
  "SELECT set_config('idle_in_transaction_session_timeout', $1, true)";
const AVATAR_LOCK_TRANSACTION_OPTIONS = {
  ...CONTROL_PLANE_TRANSACTION_OPTIONS,
  timeout: AVATAR_COMPLETION_LOCK_TRANSACTION_TIMEOUT_MS,
};

/**
 * Both ceilings are read under the account's advisory lock and the grant is
 * written in the same transaction, so two concurrent requests cannot both
 * observe headroom (#374).
 */
const COUNT_ISSUED_IN_WINDOW_SQL = `
  SELECT count(*)::int AS count
  FROM user_avatar_upload_grants
  WHERE user_account_id = $1 AND created_at > $2
`;
const COUNT_OPEN_GRANTS_SQL = `
  SELECT count(*)::int AS count
  FROM user_avatar_upload_grants
  WHERE user_account_id = $1 AND status = 'open' AND expires_at > $2
`;
const INSERT_GRANT_SQL = `
  INSERT INTO user_avatar_upload_grants
    (id, user_account_id, object_key, status, created_at, expires_at)
  VALUES ($1, $2, $3, 'open', $4, $5)
`;
const CONSUME_GRANT_SQL = `
  UPDATE user_avatar_upload_grants
  SET status = 'consumed'
  WHERE user_account_id = $1 AND id = $2
`;

function grantLockKey(userId: string): string {
  return `avatar:grants:${userId}`;
}

interface CountRow {
  readonly count: number;
}

interface AvatarIdRow {
  readonly id: unknown;
}

function storeError(cause: unknown): AppError {
  if (postgresTimeoutKind(cause) !== undefined) {
    return databaseUnavailableError(cause, 'Avatar store is unavailable');
  }
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Avatar store is unavailable',
    retryable: false,
    cause,
  });
}

function mapRow(row: UserAvatar | null): Avatar | undefined {
  if (row === null) {
    return undefined;
  }
  if (!isAvatarContentType(row.contentType)) {
    throw storeError(internalError('Avatar row is invalid'));
  }
  return {
    assetId: row.id,
    userId: row.userAccountId,
    objectKey: row.objectKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    acceptedAt: row.acceptedAt,
  };
}

export class PostgresAvatarRepository implements AvatarRepositoryPort {
  constructor(
    private readonly client: PrismaClient | Prisma.TransactionClient,
  ) {}

  async withUserLock<T>(
    userId: string,
    operation: (repository: AvatarRepositoryPort) => Promise<T>,
  ): Promise<T> {
    if (!('$transaction' in this.client)) {
      throw storeError(internalError('Avatar transaction is unavailable'));
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        await transaction.$queryRawUnsafe(
          AVATAR_IDLE_TIMEOUT_SQL,
          `${AVATAR_LOCK_IDLE_TRANSACTION_TIMEOUT_MS}ms`,
        );
        await transaction.$executeRawUnsafe(
          AVATAR_USER_LOCK_SQL,
          `avatar:${userId}`,
        );
        return operation(new PostgresAvatarRepository(transaction));
      }, AVATAR_LOCK_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storeError(error);
    }
  }

  async findByUser(userId: string): Promise<Avatar | undefined> {
    return mapRow(
      await this.run(() =>
        this.client.userAvatar.findUnique({ where: { userAccountId: userId } }),
      ),
    );
  }

  async recordedObjectKeys(
    objectKeys: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (objectKeys.length === 0) {
      return new Set();
    }
    const rows = await this.run(() =>
      this.client.userAvatar.findMany({
        where: { objectKey: { in: [...objectKeys] } },
        select: { objectKey: true },
      }),
    );
    return new Set(rows.map((row) => row.objectKey));
  }

  async openUploadGrants(
    userId: string,
    now: Date,
  ): Promise<readonly AvatarUploadGrantRecord[]> {
    const rows = await this.run(() =>
      this.client.userAvatarUploadGrant.findMany({
        where: {
          userAccountId: userId,
          status: 'open',
          expiresAt: { gt: now },
        },
        select: { id: true, objectKey: true, expiresAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((row) => ({
      assetId: row.id,
      objectKey: row.objectKey,
      expiresAt: row.expiresAt,
    }));
  }

  async grantUpload(
    grant: AvatarUploadGrantRecord & {
      readonly userId: string;
      readonly createdAt: Date;
    },
    limits: {
      readonly openLimit: number;
      readonly issuanceLimit: number;
      readonly issuanceWindowMs: number;
    },
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      await client.$executeRawUnsafe(
        AVATAR_USER_LOCK_SQL,
        grantLockKey(grant.userId),
      );
      const [open] = await client.$queryRawUnsafe<readonly CountRow[]>(
        COUNT_OPEN_GRANTS_SQL,
        grant.userId,
        grant.createdAt,
      );
      if ((open?.count ?? 0) >= limits.openLimit) return false;

      const [issued] = await client.$queryRawUnsafe<readonly CountRow[]>(
        COUNT_ISSUED_IN_WINDOW_SQL,
        grant.userId,
        new Date(grant.createdAt.getTime() - limits.issuanceWindowMs),
      );
      if ((issued?.count ?? 0) >= limits.issuanceLimit) return false;

      await client.$executeRawUnsafe(
        INSERT_GRANT_SQL,
        grant.assetId,
        grant.userId,
        grant.objectKey,
        grant.createdAt,
        grant.expiresAt,
      );
      return true;
    });
  }

  async consumeUploadGrant(userId: string, assetId: string): Promise<void> {
    await this.run(() =>
      this.client.$executeRawUnsafe(CONSUME_GRANT_SQL, userId, assetId),
    );
  }

  async record(avatar: Avatar): Promise<RecordAvatarResult> {
    const inserted = await this.run(() =>
      this.client.$queryRawUnsafe<readonly AvatarIdRow[]>(
        INSERT_SQL,
        avatar.assetId,
        avatar.userId,
        avatar.objectKey,
        avatar.contentType,
        avatar.byteSize,
        avatar.acceptedAt,
      ),
    );
    if (inserted.length === 1) {
      return { kind: 'recorded', avatar };
    }

    const existing = await this.findByUser(avatar.userId);
    if (existing?.assetId === avatar.assetId) {
      return { kind: 'already_recorded', avatar: existing };
    }
    return { kind: 'exists' };
  }

  // Conditional on the asset the caller read: a concurrent change makes the
  // update match nothing, and the caller learns it lost rather than overwriting.
  async replace(previousAssetId: string, avatar: Avatar): Promise<boolean> {
    const updated = await this.run(() =>
      this.client.userAvatar.updateMany({
        where: { userAccountId: avatar.userId, id: previousAssetId },
        data: {
          id: avatar.assetId,
          objectKey: avatar.objectKey,
          contentType: avatar.contentType,
          byteSize: avatar.byteSize,
          acceptedAt: avatar.acceptedAt,
        },
      }),
    );
    return updated.count === 1;
  }

  async remove(userId: string, assetId: string): Promise<boolean> {
    const deleted = await this.run(() =>
      this.client.userAvatar.deleteMany({
        where: { userAccountId: userId, id: assetId },
      }),
    );
    return deleted.count === 1;
  }

  private async transaction<T>(
    run: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!('$transaction' in this.client)) {
      throw storeError(internalError('Avatar transaction is unavailable'));
    }
    try {
      return await this.client.$transaction(
        (transaction) => run(transaction),
        AVATAR_LOCK_TRANSACTION_OPTIONS,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storeError(error);
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw storeError(error);
    }
  }
}
