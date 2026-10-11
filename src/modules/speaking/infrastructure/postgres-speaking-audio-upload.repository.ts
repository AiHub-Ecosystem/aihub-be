import { AppError } from '@/common/errors/app-error';
import type {
  SpeakingAudioUploadLookup,
  SpeakingAudioUploadOwner,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/speaking-audio-upload.port';
import type {
  SpeakingAudioAsset,
  SpeakingAudioEnvironment,
  SpeakingAudioUploadIntent,
} from '@/modules/speaking/domain/speaking-audio-asset';
import { isSpeakingAudioContentType } from '@/modules/speaking/domain/speaking-audio-asset';
import type { PrismaClient } from '@prisma-client/client';

export { createSpeakingAudioQueryClient } from './postgres-speaking-audio-upload.fixture-client';

type Row = Record<string, unknown>;
type Queryable = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

function storeUnavailable(cause?: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Speaking Audio store is unavailable',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw storeUnavailable(new Error('Speaking Audio row is invalid'));
  }
  return value;
}

function requiredDate(row: Row, key: string): Date {
  const value = row[key];
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw storeUnavailable(new Error('Speaking Audio row is invalid'));
  }
  return date;
}

function requiredInteger(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw storeUnavailable(new Error('Speaking Audio row is invalid'));
  }
  return value;
}

function requiredEnvironment(row: Row): SpeakingAudioEnvironment {
  const value = row.environment;
  if (value !== 'production' && value !== 'sandbox') {
    throw storeUnavailable(new Error('Speaking Audio environment is invalid'));
  }
  return value;
}

function mapIntent(
  row: Row | undefined,
): SpeakingAudioUploadIntent | undefined {
  if (row === undefined) {
    return undefined;
  }
  const contentType = requiredString(row, 'content_type');
  const status = requiredString(row, 'status');
  if (
    !isSpeakingAudioContentType(contentType) ||
    (status !== 'open' && status !== 'rejected')
  ) {
    throw storeUnavailable(new Error('Speaking Audio intent is invalid'));
  }
  return {
    assetId: requiredString(row, 'id'),
    organizationId: requiredString(row, 'organization_id'),
    endUserId: requiredString(row, 'end_user_id'),
    environment: requiredEnvironment(row),
    objectKey: requiredString(row, 'object_key'),
    contentType,
    byteSize: requiredInteger(row, 'byte_size'),
    createdAt: requiredDate(row, 'created_at'),
    expiresAt: requiredDate(row, 'expires_at'),
    status,
  };
}

function mapAsset(row: Row | undefined): SpeakingAudioAsset | undefined {
  if (row === undefined) {
    return undefined;
  }
  const contentType = requiredString(row, 'content_type');
  if (!isSpeakingAudioContentType(contentType)) {
    throw storeUnavailable(new Error('Speaking Audio asset is invalid'));
  }
  return {
    assetId: requiredString(row, 'id'),
    organizationId: requiredString(row, 'organization_id'),
    endUserId: requiredString(row, 'end_user_id'),
    environment: requiredEnvironment(row),
    objectKey: requiredString(row, 'object_key'),
    contentType,
    byteSize: requiredInteger(row, 'byte_size'),
    acceptedAt: requiredDate(row, 'accepted_at'),
    retentionExpiresAt: requiredDate(row, 'retention_expires_at'),
  };
}

const INTENT_COLUMNS = `
  id, organization_id, end_user_id, environment, object_key, content_type,
  byte_size, status, created_at, expires_at
`;

const ASSET_COLUMNS = `
  id, organization_id, end_user_id, environment, object_key, content_type,
  byte_size, accepted_at, retention_expires_at
`;

type SpeakingAudioIntentRow = Row & {
  readonly id: unknown;
  readonly organization_id: unknown;
  readonly end_user_id: unknown;
  readonly environment: unknown;
  readonly object_key: unknown;
  readonly content_type: unknown;
  readonly byte_size: unknown;
  readonly status: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
};

type SpeakingAudioAssetRow = Row & {
  readonly id: unknown;
  readonly organization_id: unknown;
  readonly end_user_id: unknown;
  readonly environment: unknown;
  readonly object_key: unknown;
  readonly content_type: unknown;
  readonly byte_size: unknown;
  readonly accepted_at: unknown;
  readonly retention_expires_at: unknown;
};

type IdRow = Row & { readonly id: unknown };

export class PostgresSpeakingAudioUploadRepository
  implements SpeakingAudioUploadRepositoryPort
{
  constructor(private readonly client: PrismaClient) {}

  async createIntent(intent: SpeakingAudioUploadIntent): Promise<void> {
    await this.execute(
      this.client,
      `
        INSERT INTO speaking_audio_upload_intents
          (id, organization_id, end_user_id, environment, object_key,
           content_type, byte_size, status, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9)
      `,
      [
        intent.assetId,
        intent.organizationId,
        intent.endUserId,
        intent.environment,
        intent.objectKey,
        intent.contentType,
        intent.byteSize,
        intent.createdAt,
        intent.expiresAt,
      ],
    );
  }

  async findUpload(
    owner: SpeakingAudioUploadOwner,
  ): Promise<SpeakingAudioUploadLookup> {
    const intent = mapIntent(
      (
        await this.run<SpeakingAudioIntentRow>(
          `
            SELECT ${INTENT_COLUMNS}
            FROM speaking_audio_upload_intents
            WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
              AND environment = $4
          `,
          [
            owner.assetId,
            owner.organizationId,
            owner.endUserId,
            owner.environment,
          ],
        )
      )[0],
    );
    if (intent !== undefined) {
      return { kind: 'intent', intent };
    }

    const asset = await this.findAsset(this.client, owner);
    return asset === undefined ? { kind: 'missing' } : { kind: 'asset', asset };
  }

  async confirmRefreshableIntent(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
  }): Promise<boolean> {
    return (
      (
        await this.run<IdRow>(
          `
          SELECT id
          FROM speaking_audio_upload_intents
          WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
            AND environment = $4 AND status = 'open' AND expires_at > $5
        `,
          [
            input.owner.assetId,
            input.owner.organizationId,
            input.owner.endUserId,
            input.owner.environment,
            input.now,
          ],
        )
      ).length === 1
    );
  }

  async rejectIntent(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
  }): Promise<boolean> {
    return (
      (
        await this.run<IdRow>(
          `
          UPDATE speaking_audio_upload_intents
          SET status = 'rejected'
          WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
            AND environment = $4 AND status = 'open'
            AND expires_at > $5
          RETURNING id
        `,
          [
            input.owner.assetId,
            input.owner.organizationId,
            input.owner.endUserId,
            input.owner.environment,
            input.now,
          ],
        )
      ).length === 1
    );
  }

  async removeRejectedIntent(owner: SpeakingAudioUploadOwner): Promise<void> {
    await this.execute(
      this.client,
      `
        DELETE FROM speaking_audio_upload_intents
        WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
          AND environment = $4 AND status = 'rejected'
      `,
      [owner.assetId, owner.organizationId, owner.endUserId, owner.environment],
    );
  }

  async completeIntent(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
    readonly asset: SpeakingAudioAsset;
  }): Promise<'created' | 'already_completed' | 'missing'> {
    return this.transaction(async (client) => {
      const intentRow = (
        await this.query<SpeakingAudioIntentRow>(
          client,
          `
            SELECT ${INTENT_COLUMNS}
            FROM speaking_audio_upload_intents
            WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
              AND environment = $4
            FOR UPDATE
          `,
          [
            input.owner.assetId,
            input.owner.organizationId,
            input.owner.endUserId,
            input.owner.environment,
          ],
        )
      )[0];

      if (intentRow === undefined) {
        return (await this.findAsset(client, input.owner)) === undefined
          ? 'missing'
          : 'already_completed';
      }

      const intent = mapIntent(intentRow);
      if (
        intent === undefined ||
        intent.status !== 'open' ||
        intent.expiresAt.getTime() <= input.now.getTime()
      ) {
        return 'missing';
      }
      if (
        input.asset.assetId !== intent.assetId ||
        input.asset.organizationId !== intent.organizationId ||
        input.asset.endUserId !== intent.endUserId ||
        input.asset.environment !== intent.environment ||
        input.asset.objectKey !== intent.objectKey ||
        input.asset.contentType !== intent.contentType ||
        input.asset.byteSize !== intent.byteSize
      ) {
        throw storeUnavailable(new Error('Speaking Audio intent changed'));
      }

      await this.execute(
        client,
        `
          INSERT INTO speaking_audio_assets
            (id, organization_id, end_user_id, environment, object_key,
             content_type, byte_size, accepted_at, retention_expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          input.asset.assetId,
          input.asset.organizationId,
          input.asset.endUserId,
          input.asset.environment,
          input.asset.objectKey,
          input.asset.contentType,
          input.asset.byteSize,
          input.asset.acceptedAt,
          input.asset.retentionExpiresAt,
        ],
      );
      const removed = await this.query<IdRow>(
        client,
        `
          DELETE FROM speaking_audio_upload_intents
          WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
            AND environment = $4 AND status = 'open'
          RETURNING id
        `,
        [
          input.owner.assetId,
          input.owner.organizationId,
          input.owner.endUserId,
          input.owner.environment,
        ],
      );
      if (removed.length !== 1) {
        throw storeUnavailable(new Error('Speaking Audio intent changed'));
      }
      return 'created';
    });
  }

  async listCleanupCandidates(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly SpeakingAudioUploadIntent[]> {
    const cursor =
      input.after === undefined ? '' : 'AND (created_at, id) > ($2, $3)';
    const values =
      input.after === undefined
        ? [input.expiredBefore, input.limit]
        : [
            input.expiredBefore,
            input.after.createdAt,
            input.after.assetId,
            input.limit,
          ];
    const limitParameter = input.after === undefined ? '$2' : '$4';
    const rows = await this.run<SpeakingAudioIntentRow>(
      `
        SELECT ${INTENT_COLUMNS}
        FROM speaking_audio_upload_intents
        WHERE (status = 'rejected'
           OR (status = 'open' AND expires_at <= $1))
          ${cursor}
        ORDER BY created_at, id
        LIMIT ${limitParameter}
      `,
      values,
    );
    return rows.flatMap((row) => {
      const intent = mapIntent(row);
      return intent === undefined ? [] : [intent];
    });
  }

  async removeCleanupCandidate(input: {
    readonly intent: SpeakingAudioUploadIntent;
    readonly expiredBefore: Date;
  }): Promise<boolean> {
    const { intent } = input;
    const result = await this.run<IdRow>(
      `
        DELETE FROM speaking_audio_upload_intents
        WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
          AND environment = $4 AND object_key = $5 AND status = $6
          AND ($6 = 'rejected' OR expires_at <= $7)
        RETURNING id
      `,
      [
        intent.assetId,
        intent.organizationId,
        intent.endUserId,
        intent.environment,
        intent.objectKey,
        intent.status,
        input.expiredBefore,
      ],
    );
    return result.length === 1;
  }

  private async findAsset(
    client: Queryable,
    owner: SpeakingAudioUploadOwner,
  ): Promise<SpeakingAudioAsset | undefined> {
    return mapAsset(
      (
        await this.query<SpeakingAudioAssetRow>(
          client,
          `
            SELECT ${ASSET_COLUMNS}
            FROM speaking_audio_assets
            WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
              AND environment = $4
          `,
          [
            owner.assetId,
            owner.organizationId,
            owner.endUserId,
            owner.environment,
          ],
        )
      )[0],
    );
  }

  private async transaction<T>(
    run: (client: Queryable) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.client.$transaction((client) => run(client));
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw storeUnavailable(error);
    }
  }

  private async run<Result extends object = Row>(
    sql: string,
    values: readonly unknown[],
  ): Promise<readonly Result[]> {
    return this.query(this.client, sql, values);
  }

  private async query<Result extends object = Row>(
    client: Queryable,
    sql: string,
    values: readonly unknown[],
  ): Promise<readonly Result[]> {
    try {
      return await client.$queryRawUnsafe<readonly Result[]>(sql, ...values);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw storeUnavailable(error);
    }
  }

  private async execute(
    client: Queryable,
    sql: string,
    values: readonly unknown[],
  ): Promise<number> {
    try {
      return await client.$executeRawUnsafe(sql, ...values);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw storeUnavailable(error);
    }
  }
}
