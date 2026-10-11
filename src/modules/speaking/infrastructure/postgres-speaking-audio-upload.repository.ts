import { AppError } from '@/common/errors/app-error';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
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
import type {
  SpeakingAudioAsset as AssetModel,
  SpeakingAudioUploadIntent as IntentModel,
  Prisma,
  PrismaClient,
} from '@prisma-client/client';

export { createSpeakingAudioQueryClient } from './postgres-speaking-audio-upload.fixture-client';

function storeUnavailable(cause?: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Speaking Audio store is unavailable',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

function requiredEnvironment(value: string): SpeakingAudioEnvironment {
  if (value !== 'production' && value !== 'sandbox') {
    throw storeUnavailable(new Error('Speaking Audio environment is invalid'));
  }
  return value;
}

function mapIntent(
  row: IntentModel | undefined,
): SpeakingAudioUploadIntent | undefined {
  if (row === undefined) {
    return undefined;
  }
  if (
    !isSpeakingAudioContentType(row.contentType) ||
    (row.status !== 'open' && row.status !== 'rejected')
  ) {
    throw storeUnavailable(new Error('Speaking Audio intent is invalid'));
  }
  return {
    assetId: row.id,
    organizationId: row.organizationId,
    endUserId: row.endUserId,
    environment: requiredEnvironment(row.environment),
    objectKey: row.objectKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: row.status,
  };
}

function mapAsset(row: AssetModel | undefined): SpeakingAudioAsset | undefined {
  if (row === undefined) {
    return undefined;
  }
  if (!isSpeakingAudioContentType(row.contentType)) {
    throw storeUnavailable(new Error('Speaking Audio asset is invalid'));
  }
  return {
    assetId: row.id,
    organizationId: row.organizationId,
    endUserId: row.endUserId,
    environment: requiredEnvironment(row.environment),
    objectKey: row.objectKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    acceptedAt: row.acceptedAt,
    retentionExpiresAt: row.retentionExpiresAt,
  };
}

function ownerWhere(owner: SpeakingAudioUploadOwner) {
  return {
    id: owner.assetId,
    organizationId: owner.organizationId,
    endUserId: owner.endUserId,
    environment: owner.environment,
  };
}

/**
 * The one row lock in this repository stays SQL: Prisma has no `FOR UPDATE`.
 * Columns are aliased to the model's field names so the row maps like any other.
 */
const LOCK_INTENT_SQL = `
  SELECT
    id,
    organization_id AS "organizationId",
    end_user_id AS "endUserId",
    environment,
    object_key AS "objectKey",
    content_type AS "contentType",
    byte_size AS "byteSize",
    status,
    created_at AS "createdAt",
    expires_at AS "expiresAt"
  FROM speaking_audio_upload_intents
  WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
    AND environment = $4
  FOR UPDATE
`;

export class PostgresSpeakingAudioUploadRepository
  implements SpeakingAudioUploadRepositoryPort
{
  constructor(private readonly client: PrismaClient) {}

  async createIntent(intent: SpeakingAudioUploadIntent): Promise<void> {
    await this.run(() =>
      this.client.speakingAudioUploadIntent.create({
        data: {
          id: intent.assetId,
          organizationId: intent.organizationId,
          endUserId: intent.endUserId,
          environment: intent.environment,
          objectKey: intent.objectKey,
          contentType: intent.contentType,
          byteSize: intent.byteSize,
          status: 'open',
          createdAt: intent.createdAt,
          expiresAt: intent.expiresAt,
        },
      }),
    );
  }

  async findUpload(
    owner: SpeakingAudioUploadOwner,
  ): Promise<SpeakingAudioUploadLookup> {
    const intent = mapIntent(
      (await this.run(() =>
        this.client.speakingAudioUploadIntent.findFirst({
          where: ownerWhere(owner),
        }),
      )) ?? undefined,
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
    const matching = await this.run(() =>
      this.client.speakingAudioUploadIntent.count({
        where: {
          ...ownerWhere(input.owner),
          status: 'open',
          expiresAt: { gt: input.now },
        },
      }),
    );
    return matching === 1;
  }

  async rejectIntent(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
  }): Promise<boolean> {
    const updated = await this.run(() =>
      this.client.speakingAudioUploadIntent.updateMany({
        where: {
          ...ownerWhere(input.owner),
          status: 'open',
          expiresAt: { gt: input.now },
        },
        data: { status: 'rejected' },
      }),
    );
    return updated.count === 1;
  }

  async removeRejectedIntent(owner: SpeakingAudioUploadOwner): Promise<void> {
    await this.run(() =>
      this.client.speakingAudioUploadIntent.deleteMany({
        where: { ...ownerWhere(owner), status: 'rejected' },
      }),
    );
  }

  async completeIntent(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
    readonly asset: SpeakingAudioAsset;
  }): Promise<'created' | 'already_completed' | 'missing'> {
    return this.transaction(async (client) => {
      const [intentRow] = await client.$queryRawUnsafe<readonly IntentModel[]>(
        LOCK_INTENT_SQL,
        input.owner.assetId,
        input.owner.organizationId,
        input.owner.endUserId,
        input.owner.environment,
      );

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

      await client.speakingAudioAsset.create({
        data: {
          id: input.asset.assetId,
          organizationId: input.asset.organizationId,
          endUserId: input.asset.endUserId,
          environment: input.asset.environment,
          objectKey: input.asset.objectKey,
          contentType: input.asset.contentType,
          byteSize: input.asset.byteSize,
          acceptedAt: input.asset.acceptedAt,
          retentionExpiresAt: input.asset.retentionExpiresAt,
        },
      });
      const removed = await client.speakingAudioUploadIntent.deleteMany({
        where: { ...ownerWhere(input.owner), status: 'open' },
      });
      if (removed.count !== 1) {
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
    const { after } = input;
    const rows = await this.run(() =>
      this.client.speakingAudioUploadIntent.findMany({
        where: {
          AND: [
            {
              OR: [
                { status: 'rejected' },
                { status: 'open', expiresAt: { lte: input.expiredBefore } },
              ],
            },
            // `(created_at, id) > ($after.createdAt, $after.assetId)`
            ...(after === undefined
              ? []
              : [
                  {
                    OR: [
                      { createdAt: { gt: after.createdAt } },
                      {
                        createdAt: after.createdAt,
                        id: { gt: after.assetId },
                      },
                    ],
                  },
                ]),
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: input.limit,
      }),
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
    const removed = await this.run(() =>
      this.client.speakingAudioUploadIntent.deleteMany({
        where: {
          id: intent.assetId,
          organizationId: intent.organizationId,
          endUserId: intent.endUserId,
          environment: intent.environment,
          objectKey: intent.objectKey,
          status: intent.status,
          // A rejected intent is removable at once; an open one only after expiry.
          ...(intent.status === 'rejected'
            ? {}
            : { expiresAt: { lte: input.expiredBefore } }),
        },
      }),
    );
    return removed.count === 1;
  }

  private async findAsset(
    client: Pick<Prisma.TransactionClient, 'speakingAudioAsset'>,
    owner: SpeakingAudioUploadOwner,
  ): Promise<SpeakingAudioAsset | undefined> {
    return mapAsset(
      (await this.run(() =>
        client.speakingAudioAsset.findFirst({ where: ownerWhere(owner) }),
      )) ?? undefined,
    );
  }

  private async transaction<T>(
    run: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.client.$transaction(
        (client) => run(client),
        CONTROL_PLANE_TRANSACTION_OPTIONS,
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw storeUnavailable(error);
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw storeUnavailable(error);
    }
  }
}
