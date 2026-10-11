import { AppError } from '@/common/errors/app-error';
import type {
  AvatarRepositoryPort,
  RecordAvatarResult,
} from '@/modules/avatar/application/avatar-repository.port';
import {
  type Avatar,
  isAvatarContentType,
} from '@/modules/avatar/domain/avatar';
import type { AvatarQueryClient } from './prisma-avatar.client';

export { createAvatarQueryClient } from './postgres-avatar.fixture-client';
export type { AvatarQueryClient } from './prisma-avatar.client';

const FIND_BY_USER_SQL = `
  SELECT id, user_account_id, object_key, content_type, byte_size, accepted_at
  FROM user_avatars
  WHERE user_account_id = $1
`;

const RECORDED_KEYS_SQL = `
  SELECT object_key
  FROM user_avatars
  WHERE object_key = ANY($1::text[])
`;

// The unique constraint on the account is what keeps one Avatar per account,
// including under two concurrent completions.
const INSERT_SQL = `
  INSERT INTO user_avatars
    (id, user_account_id, object_key, content_type, byte_size, accepted_at)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (user_account_id) DO NOTHING
  RETURNING id
`;

// Conditional on the asset the caller read: a concurrent change makes these
// match nothing, and the caller learns it lost rather than overwriting.
const REPLACE_SQL = `
  UPDATE user_avatars
  SET id = $3, object_key = $4, content_type = $5, byte_size = $6,
      accepted_at = $7
  WHERE user_account_id = $1
    AND id = $2
  RETURNING id
`;

const DELETE_SQL = `
  DELETE FROM user_avatars
  WHERE user_account_id = $1
    AND id = $2
  RETURNING id
`;

interface AvatarRecordRow {
  readonly id: unknown;
  readonly user_account_id: unknown;
  readonly object_key: unknown;
  readonly content_type: unknown;
  readonly byte_size: unknown;
  readonly accepted_at: unknown;
}

interface AvatarObjectKeyRow {
  readonly object_key: unknown;
}

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

function mapRow(row: AvatarRecordRow | undefined): Avatar | undefined {
  if (row === undefined) {
    return undefined;
  }
  const {
    id,
    user_account_id: userId,
    object_key: objectKey,
    content_type: contentType,
    byte_size: byteSize,
    accepted_at: acceptedAt,
  } = row;
  if (
    typeof id !== 'string' ||
    typeof userId !== 'string' ||
    typeof objectKey !== 'string' ||
    typeof contentType !== 'string' ||
    !isAvatarContentType(contentType) ||
    typeof byteSize !== 'number' ||
    !(acceptedAt instanceof Date)
  ) {
    throw storeError(new Error('Avatar row is invalid'));
  }
  return { assetId: id, userId, objectKey, contentType, byteSize, acceptedAt };
}

export class PostgresAvatarRepository implements AvatarRepositoryPort {
  constructor(private readonly client: AvatarQueryClient) {}

  async findByUser(userId: string): Promise<Avatar | undefined> {
    return mapRow(
      (await this.run<AvatarRecordRow>(FIND_BY_USER_SQL, [userId]))[0],
    );
  }

  async recordedObjectKeys(
    objectKeys: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (objectKeys.length === 0) {
      return new Set();
    }
    const rows = await this.run<AvatarObjectKeyRow>(RECORDED_KEYS_SQL, [
      [...objectKeys],
    ]);
    return new Set(
      rows.flatMap((row) =>
        typeof row.object_key === 'string' ? [row.object_key] : [],
      ),
    );
  }

  async record(avatar: Avatar): Promise<RecordAvatarResult> {
    const inserted = await this.run<AvatarIdRow>(INSERT_SQL, [
      avatar.assetId,
      avatar.userId,
      avatar.objectKey,
      avatar.contentType,
      avatar.byteSize,
      avatar.acceptedAt,
    ]);
    if (inserted.length === 1) {
      return { kind: 'recorded', avatar };
    }

    const existing = await this.findByUser(avatar.userId);
    if (existing?.assetId === avatar.assetId) {
      return { kind: 'already_recorded', avatar: existing };
    }
    return { kind: 'exists' };
  }

  async replace(previousAssetId: string, avatar: Avatar): Promise<boolean> {
    const updated = await this.run<AvatarIdRow>(REPLACE_SQL, [
      avatar.userId,
      previousAssetId,
      avatar.assetId,
      avatar.objectKey,
      avatar.contentType,
      avatar.byteSize,
      avatar.acceptedAt,
    ]);
    return updated.length === 1;
  }

  async remove(userId: string, assetId: string): Promise<boolean> {
    return (
      (await this.run<AvatarIdRow>(DELETE_SQL, [userId, assetId])).length === 1
    );
  }

  private async run<Row extends object = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    try {
      return await this.client.query<Row>(sql, values);
    } catch (error) {
      throw storeError(error);
    }
  }
}
