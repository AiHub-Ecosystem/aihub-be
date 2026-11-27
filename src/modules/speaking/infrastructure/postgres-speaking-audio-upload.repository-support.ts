import { AppError, internalError } from '@/common/errors/app-error';
import { storeUnavailable } from '@/common/errors/upload-errors';
import { organizationTransaction } from '@/modules/persistence/persistence.module';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { SPEAKING_AUDIO_COMPLETION_TRANSACTION_TIMEOUT_MS } from '@/modules/speaking/application/audio/speaking-audio-completion-timeouts';
import type { SpeakingAudioUploadOwner } from '@/modules/speaking/application/audio/speaking-audio-upload.port';
import {
  type SpeakingAudioAsset,
  type SpeakingAudioEnvironment,
  type SpeakingAudioUploadIntent,
  isSpeakingAudioContentType,
  isSpeakingAudioObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';
import type {
  SpeakingAudioAsset as AssetModel,
  SpeakingAudioUploadIntent as IntentModel,
  Prisma,
  PrismaClient,
} from '@prisma-client/client';

export function requiredEnvironment(value: string): SpeakingAudioEnvironment {
  if (value !== 'production' && value !== 'sandbox') {
    throw storeUnavailable(
      'INTERNAL_ERROR',
      'Speaking Audio store is unavailable',
      false,
      internalError('Speaking Audio environment is invalid'),
    );
  }
  return value;
}

export function mapIntent(
  row: IntentModel | undefined,
): SpeakingAudioUploadIntent | undefined {
  if (row === undefined) return undefined;
  if (
    !isSpeakingAudioContentType(row.contentType) ||
    !isSpeakingAudioObjectKey(row.objectKey) ||
    (row.status !== 'open' && row.status !== 'rejected')
  ) {
    throw storeUnavailable(
      'INTERNAL_ERROR',
      'Speaking Audio store is unavailable',
      false,
      internalError('Speaking Audio intent is invalid'),
    );
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

export function mapAsset(
  row: AssetModel | undefined,
): SpeakingAudioAsset | undefined {
  if (row === undefined) return undefined;
  if (
    !isSpeakingAudioContentType(row.contentType) ||
    !isSpeakingAudioObjectKey(row.objectKey)
  ) {
    throw storeUnavailable(
      'INTERNAL_ERROR',
      'Speaking Audio store is unavailable',
      false,
      internalError('Speaking Audio asset is invalid'),
    );
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

export function ownerWhere(
  owner: SpeakingAudioUploadOwner,
): Pick<IntentModel, 'id' | 'organizationId' | 'endUserId' | 'environment'> {
  return {
    id: owner.assetId,
    organizationId: owner.organizationId,
    endUserId: owner.endUserId,
    environment: owner.environment,
  };
}

export const LOCK_INTENT_SQL = `
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

export const LOCK_PUBLICATION_PROTOCOL_SQL = `
  SELECT activated_at IS NOT NULL AS active
  FROM speaking_audio_publication_protocol
  WHERE id = true
  FOR SHARE
`;

export class SpeakingAudioUploadRepositorySupport {
  constructor(protected readonly client: PrismaClient) {}

  protected async findAsset(
    client: Pick<Prisma.TransactionClient, 'speakingAudioAsset'>,
    owner: SpeakingAudioUploadOwner,
  ): Promise<SpeakingAudioAsset | undefined> {
    return mapAsset(
      (await this.run(() =>
        client.speakingAudioAsset.findFirst({ where: ownerWhere(owner) }),
      )) ?? undefined,
    );
  }

  protected async transaction<T>(
    organizationId: string,
    run: (client: Prisma.TransactionClient) => Promise<T>,
    options: {
      readonly maxWait: number;
      readonly timeout: number;
    } = CONTROL_PLANE_TRANSACTION_OPTIONS,
  ): Promise<T> {
    try {
      return await organizationTransaction(
        this.client,
        organizationId,
        run,
        options,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storeUnavailable(
        'INTERNAL_ERROR',
        'Speaking Audio store is unavailable',
        false,
        error,
      );
    }
  }

  protected async completionTransaction<T>(
    organizationId: string,
    run: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(organizationId, run, {
      ...CONTROL_PLANE_TRANSACTION_OPTIONS,
      timeout: SPEAKING_AUDIO_COMPLETION_TRANSACTION_TIMEOUT_MS,
    });
  }

  protected async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storeUnavailable(
        'INTERNAL_ERROR',
        'Speaking Audio store is unavailable',
        false,
        error,
      );
    }
  }
}
