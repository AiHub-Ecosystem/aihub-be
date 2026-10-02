import { Pool } from 'pg';

import { AppError } from '@/common/errors/app-error';
import type {
  AvatarRepositoryPort,
  RecordAvatarResult,
} from '@/modules/avatar/application/avatar-repository.port';
import {
  type Avatar,
  isAvatarContentType,
} from '@/modules/avatar/domain/avatar';

const FIND_BY_USER_SQL = `
  SELECT id, user_account_id, object_key, content_type, byte_size, accepted_at
  FROM user_avatars
  WHERE user_account_id = $1
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

export interface AvatarQueryClient {
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

function storeError(cause: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Avatar store is unavailable',
    retryable: false,
    cause,
  });
}

function mapRow(row: Record<string, unknown> | undefined): Avatar | undefined {
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
    let rows: readonly Record<string, unknown>[];
    try {
      ({ rows } = await this.client.query(FIND_BY_USER_SQL, [userId]));
    } catch (error) {
      throw storeError(error);
    }
    return mapRow(rows[0]);
  }

  async record(avatar: Avatar): Promise<RecordAvatarResult> {
    let inserted: readonly Record<string, unknown>[];
    try {
      ({ rows: inserted } = await this.client.query(INSERT_SQL, [
        avatar.assetId,
        avatar.userId,
        avatar.objectKey,
        avatar.contentType,
        avatar.byteSize,
        avatar.acceptedAt,
      ]));
    } catch (error) {
      throw storeError(error);
    }
    if (inserted.length === 1) {
      return { kind: 'recorded', avatar };
    }

    const existing = await this.findByUser(avatar.userId);
    if (existing?.assetId === avatar.assetId) {
      return { kind: 'already_recorded', avatar: existing };
    }
    return { kind: 'exists' };
  }
}

/**
 * The module's own pool, closed with the application. An empty URL yields a
 * client that fails every query, as the other modules' clients do.
 */
export function createAvatarQueryClient(
  databaseUrl: string,
): AvatarQueryClient & { close(): Promise<void> } {
  if (databaseUrl.trim().length === 0) {
    return {
      query: async () => {
        throw new Error('DATABASE_URL is missing');
      },
      close: async () => undefined,
    };
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
  });
  return {
    query: (text, values) =>
      pool.query<Record<string, unknown>>(text, [...values]),
    close: () => pool.end(),
  };
}
