import { Pool } from 'pg';

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

type Row = Record<string, unknown>;

interface QueryResult {
  readonly rows: readonly Row[];
}

interface Queryable {
  query(text: string, values: readonly unknown[]): Promise<QueryResult>;
}

interface TransactionClient extends Queryable {
  release(): void;
}

export interface SpeakingAudioQueryClient extends Queryable {
  connect(): Promise<TransactionClient>;
  close(): Promise<void>;
}

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

export class PostgresSpeakingAudioUploadRepository
  implements SpeakingAudioUploadRepositoryPort
{
  constructor(private readonly client: SpeakingAudioQueryClient) {}

  async createIntent(intent: SpeakingAudioUploadIntent): Promise<void> {
    await this.run(
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
        await this.run(
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
        await this.run(
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
        await this.run(
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
    await this.run(
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
        await this.query(
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

      await this.query(
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
      const removed = await this.query(
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
    const rows = await this.run(
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
    const result = await this.run(
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
        await this.query(
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
    let client: TransactionClient;
    try {
      client = await this.client.connect();
    } catch (error) {
      throw storeUnavailable(error);
    }

    try {
      await this.query(client, 'BEGIN', []);
      const result = await run(client);
      await this.query(client, 'COMMIT', []);
      return result;
    } catch (error) {
      await this.query(client, 'ROLLBACK', []).catch(() => undefined);
      if (error instanceof AppError) {
        throw error;
      }
      throw storeUnavailable(error);
    } finally {
      client.release();
    }
  }

  private async run(
    sql: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    return this.query(this.client, sql, values);
  }

  private async query(
    client: Queryable,
    sql: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    try {
      return (await client.query(sql, values)).rows;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw storeUnavailable(error);
    }
  }
}

export function createSpeakingAudioQueryClient(
  databaseUrl: string,
): SpeakingAudioQueryClient {
  if (databaseUrl.trim().length === 0) {
    return {
      query: async () => {
        throw new Error('DATABASE_URL is missing');
      },
      connect: async () => {
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
      pool.query<Row>(text, [...values]).then(({ rows }) => ({ rows })),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (text, values) =>
          client.query<Row>(text, [...values]).then(({ rows }) => ({ rows })),
        release: () => client.release(),
      };
    },
    close: () => pool.end(),
  };
}
