import { AppError } from '@/common/errors/app-error';
import type {
  AvatarRepositoryPort,
  RecordAvatarResult,
} from '@/modules/avatar/application/avatar-repository.port';
import {
  type Avatar,
  isAvatarContentType,
} from '@/modules/avatar/domain/avatar';
import type { PrismaClient, UserAvatar } from '@prisma-client/client';

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

interface AvatarIdRow {
  readonly id: unknown;
}

function storeError(cause: unknown): AppError {
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
    throw storeError(new Error('Avatar row is invalid'));
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
  constructor(private readonly client: PrismaClient) {}

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

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw storeError(error);
    }
  }
}
