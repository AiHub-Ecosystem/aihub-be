import { ulid } from 'ulid';

import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  SpeakingAudioAsset,
  SpeakingAudioContentType,
  SpeakingAudioEnvironment,
  SpeakingAudioUploadIntent,
} from '@/modules/speaking/domain/speaking-audio-asset';
import {
  SPEAKING_AUDIO_MAX_BYTES,
  SPEAKING_AUDIO_MIN_BYTES,
  SPEAKING_AUDIO_RETENTION_MS,
  SPEAKING_AUDIO_UPLOAD_INTENT_TTL_MS,
  isSpeakingAudioAssetId,
  isSpeakingAudioContentType,
  speakingAudioObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';

import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadOwner,
  SpeakingAudioUploadRepositoryPort,
  SpeakingAudioUploadServicePort,
} from './speaking-audio-upload.port';

const STORAGE_ERROR = 'SPEAKING_AUDIO_STORAGE_UNAVAILABLE' as const;

function storageUnavailable(): AppError {
  return new AppError({
    code: STORAGE_ERROR,
    message: 'Speaking audio storage is unavailable',
    retryable: true,
  });
}

function uploadNotFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: 'Speaking audio upload was not found',
    retryable: true,
  });
}

function payloadTooLarge(): AppError {
  return new AppError({
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Speaking audio recording is larger than 25 MiB',
    retryable: false,
  });
}

function ownerFromContext(
  context: RequestContext,
  assetId: string,
): SpeakingAudioUploadOwner {
  const { organizationId, endUserId, environment } =
    uploadContextOwner(context);

  return { assetId, organizationId, endUserId, environment };
}

function uploadContextOwner(context: RequestContext): {
  readonly organizationId: string;
  readonly endUserId: string;
  readonly environment: SpeakingAudioEnvironment;
} {
  if (
    context.organizationId === undefined ||
    context.userId === undefined ||
    (context.environment !== 'production' && context.environment !== 'sandbox')
  ) {
    throw storageUnavailable();
  }

  return {
    organizationId: context.organizationId,
    endUserId: context.userId,
    environment: context.environment as SpeakingAudioEnvironment,
  };
}

function invalidStoredObject(
  contentType: string | undefined,
  byteSize: number | undefined,
  intent: SpeakingAudioUploadIntent,
): AppError | undefined {
  if (
    byteSize !== undefined &&
    Number.isInteger(byteSize) &&
    byteSize > SPEAKING_AUDIO_MAX_BYTES
  ) {
    return payloadTooLarge();
  }

  if (
    !isSpeakingAudioContentType(contentType) ||
    byteSize === undefined ||
    !Number.isInteger(byteSize) ||
    byteSize < SPEAKING_AUDIO_MIN_BYTES ||
    contentType !== intent.contentType ||
    byteSize !== intent.byteSize
  ) {
    return invalidRequest();
  }

  return undefined;
}

export class SpeakingAudioUploadService
  implements SpeakingAudioUploadServicePort
{
  constructor(
    private readonly repository: SpeakingAudioUploadRepositoryPort,
    private readonly storage: SpeakingAudioAssetStoragePort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async requestUpload(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }): ReturnType<SpeakingAudioUploadServicePort['requestUpload']> {
    if (
      !isSpeakingAudioContentType(input.contentType) ||
      !Number.isInteger(input.byteSize) ||
      input.byteSize < SPEAKING_AUDIO_MIN_BYTES
    ) {
      throw invalidRequest();
    }
    if (input.byteSize > SPEAKING_AUDIO_MAX_BYTES) {
      throw payloadTooLarge();
    }

    const owner = uploadContextOwner(input.context);
    const createdAt = this.now();
    const assetId = `aud_${ulid()}`;
    const objectKey = speakingAudioObjectKey(owner.organizationId, assetId);
    const intentExpiresAt = new Date(
      createdAt.getTime() + SPEAKING_AUDIO_UPLOAD_INTENT_TTL_MS,
    );
    const signed = await this.storage.createUploadUrl({
      environment: owner.environment,
      objectKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
    });

    const intent: SpeakingAudioUploadIntent = {
      assetId,
      ...owner,
      objectKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
      createdAt,
      expiresAt: intentExpiresAt,
      status: 'open',
    };
    await this.repository.createIntent(intent);

    return {
      assetId,
      objectKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
      uploadUrl: signed.url,
      uploadUrlExpiresAt: signed.expiresAt,
      intentExpiresAt,
    };
  }

  async refreshUpload(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): ReturnType<SpeakingAudioUploadServicePort['requestUpload']> {
    if (!isSpeakingAudioAssetId(input.assetId)) {
      throw invalidRequest();
    }
    const owner = ownerFromContext(input.context, input.assetId);
    const found = await this.repository.findUpload(owner);
    if (
      found.kind !== 'intent' ||
      found.intent.status !== 'open' ||
      found.intent.expiresAt.getTime() <= this.now().getTime()
    ) {
      throw uploadNotFound();
    }

    const signed = await this.storage.createUploadUrl({
      environment: found.intent.environment,
      objectKey: found.intent.objectKey,
      contentType: found.intent.contentType,
      byteSize: found.intent.byteSize,
    });
    const refreshedAt = this.now();
    if (
      !(await this.repository.confirmRefreshableIntent({
        owner,
        now: refreshedAt,
      }))
    ) {
      throw uploadNotFound();
    }

    return {
      assetId: found.intent.assetId,
      objectKey: found.intent.objectKey,
      contentType: found.intent.contentType,
      byteSize: found.intent.byteSize,
      uploadUrl: signed.url,
      uploadUrlExpiresAt: signed.expiresAt,
      intentExpiresAt: found.intent.expiresAt,
    };
  }

  async completeUpload(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<{
    readonly asset: SpeakingAudioAsset;
    readonly created: boolean;
  }> {
    if (!isSpeakingAudioAssetId(input.assetId)) {
      throw invalidRequest();
    }

    const owner = ownerFromContext(input.context, input.assetId);
    const found = await this.repository.findUpload(owner);
    if (found.kind === 'asset') {
      return { asset: found.asset, created: false };
    }
    if (
      found.kind !== 'intent' ||
      found.intent.status !== 'open' ||
      found.intent.expiresAt.getTime() <= this.now().getTime()
    ) {
      throw uploadNotFound();
    }

    const stored = await this.storage.describeObject({
      environment: found.intent.environment,
      objectKey: found.intent.objectKey,
    });
    if (stored === undefined) {
      throw uploadNotFound();
    }

    const refusal = invalidStoredObject(
      stored.contentType,
      stored.byteSize,
      found.intent,
    );
    if (refusal !== undefined) {
      const rejected = await this.repository.rejectIntent({
        owner,
        now: this.now(),
      });
      if (!rejected) {
        const current = await this.repository.findUpload(owner);
        if (current.kind === 'asset') {
          return { asset: current.asset, created: false };
        }
      } else {
        try {
          await this.storage.deleteObject({
            environment: found.intent.environment,
            objectKey: found.intent.objectKey,
          });
          await this.repository.removeRejectedIntent(owner);
        } catch {
          // The rejected intent remains durable so a later sweep can retry.
        }
      }
      throw refusal;
    }

    const acceptedAt = this.now();
    const asset: SpeakingAudioAsset = {
      assetId: found.intent.assetId,
      organizationId: found.intent.organizationId,
      endUserId: found.intent.endUserId,
      environment: found.intent.environment,
      objectKey: found.intent.objectKey,
      contentType: found.intent.contentType as SpeakingAudioContentType,
      byteSize: found.intent.byteSize,
      acceptedAt,
      retentionExpiresAt: new Date(
        acceptedAt.getTime() + SPEAKING_AUDIO_RETENTION_MS,
      ),
    };
    const result = await this.repository.completeIntent({
      owner,
      now: acceptedAt,
      asset,
    });
    if (result === 'missing') {
      const current = await this.repository.findUpload(owner);
      if (current.kind === 'asset') {
        return { asset: current.asset, created: false };
      }
      throw uploadNotFound();
    }

    return {
      asset,
      created: result === 'created',
    };
  }
}
