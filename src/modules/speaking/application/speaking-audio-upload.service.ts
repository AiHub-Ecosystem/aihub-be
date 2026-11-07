import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import {
  payloadTooLarge,
  storageUnavailable,
  uploadNotFound,
} from '@/common/errors/upload-errors';
import type { IdMinter } from '@/common/ids/prefixed-id';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  SpeakingAudioAsset,
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
  speakingAudioStagingObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';
import { SPEAKING_AUDIO_COMPLETION_DEADLINE_MS } from './speaking-audio-completion-timeouts';

import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadGrant,
  SpeakingAudioUploadOwner,
  SpeakingAudioUploadRepositoryPort,
  SpeakingAudioUploadServicePort,
} from './speaking-audio-upload.port';

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
    throw storageUnavailable(
      'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
      'Speaking audio storage is unavailable',
    );
  }

  return {
    organizationId: context.organizationId,
    endUserId: context.userId,
    environment: context.environment,
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
    return payloadTooLarge(
      'PAYLOAD_TOO_LARGE',
      'Speaking audio recording is larger than 25 MiB',
    );
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
    private readonly newAssetId: IdMinter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async requestUpload(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<SpeakingAudioUploadGrant> {
    if (
      !isSpeakingAudioContentType(input.contentType) ||
      !Number.isInteger(input.byteSize) ||
      input.byteSize < SPEAKING_AUDIO_MIN_BYTES
    ) {
      throw invalidRequest();
    }
    if (input.byteSize > SPEAKING_AUDIO_MAX_BYTES) {
      throw payloadTooLarge(
        'PAYLOAD_TOO_LARGE',
        'Speaking audio recording is larger than 25 MiB',
      );
    }

    const owner = uploadContextOwner(input.context);
    const createdAt = this.now();
    const assetId = this.newAssetId(createdAt);
    const objectKey = speakingAudioObjectKey(owner.organizationId, assetId);
    const intentExpiresAt = new Date(
      createdAt.getTime() + SPEAKING_AUDIO_UPLOAD_INTENT_TTL_MS,
    );
    const signed = await this.storage.createUploadUrl({
      environment: owner.environment,
      objectKey: speakingAudioStagingObjectKey(owner.organizationId, assetId),
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
  }): Promise<SpeakingAudioUploadGrant> {
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
      throw uploadNotFound('NOT_FOUND', 'Speaking audio upload was not found');
    }

    const signed = await this.storage.createUploadUrl({
      environment: found.intent.environment,
      objectKey: speakingAudioStagingObjectKey(
        found.intent.organizationId,
        found.intent.assetId,
      ),
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
      throw uploadNotFound('NOT_FOUND', 'Speaking audio upload was not found');
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
      throw uploadNotFound('NOT_FOUND', 'Speaking audio upload was not found');
    }

    const completionSignal = AbortSignal.any([
      input.context.signal,
      AbortSignal.timeout(SPEAKING_AUDIO_COMPLETION_DEADLINE_MS),
    ]);
    const result = await this.repository.completeIntent({
      owner,
      now: this.now,
      prepare: async (intent) => {
        const stagingKey = speakingAudioStagingObjectKey(
          intent.organizationId,
          intent.assetId,
        );
        const staging = await this.storage.describeObject(
          { environment: intent.environment, objectKey: stagingKey },
          completionSignal,
        );
        if (staging === undefined) {
          throw uploadNotFound(
            'NOT_FOUND',
            'Speaking audio upload was not found',
          );
        }

        const stagingRefusal = invalidStoredObject(
          staging.contentType,
          staging.byteSize,
          intent,
        );
        if (stagingRefusal !== undefined) {
          return { kind: 'refused', refusal: stagingRefusal };
        }

        if (completionSignal.aborted) {
          throw storageUnavailable(
            'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
            'Speaking audio storage is unavailable',
          );
        }
        await this.storage.copyObject(
          {
            environment: intent.environment,
            sourceObjectKey: stagingKey,
            destinationObjectKey: intent.objectKey,
          },
          completionSignal,
        );
        const finalObject = await this.storage.describeObject(
          { environment: intent.environment, objectKey: intent.objectKey },
          completionSignal,
        );
        const finalRefusal = invalidStoredObject(
          finalObject?.contentType,
          finalObject?.byteSize,
          intent,
        );
        if (finalRefusal !== undefined) {
          return { kind: 'refused', refusal: finalRefusal };
        }

        const acceptedAt = this.now();
        const acceptedAsset: SpeakingAudioAsset = {
          assetId: intent.assetId,
          organizationId: intent.organizationId,
          endUserId: intent.endUserId,
          environment: intent.environment,
          objectKey: intent.objectKey,
          contentType: intent.contentType,
          byteSize: intent.byteSize,
          acceptedAt,
          retentionExpiresAt: new Date(
            acceptedAt.getTime() + SPEAKING_AUDIO_RETENTION_MS,
          ),
        };
        return { kind: 'accepted', asset: acceptedAsset };
      },
    });

    if (result.kind === 'refused') {
      await this.cleanupRejectedIntent(
        owner,
        found.intent,
        input.context.signal,
      );
      throw result.refusal;
    }
    if (result.kind === 'created') {
      await this.deleteStagingBestEffort(
        found.intent,
        speakingAudioStagingObjectKey(
          found.intent.organizationId,
          found.intent.assetId,
        ),
      );
      return { asset: result.asset, created: true };
    }
    if (result.kind === 'already_completed') {
      return { asset: result.asset, created: false };
    }
    throw uploadNotFound('NOT_FOUND', 'Speaking audio upload was not found');
  }

  private async cleanupRejectedIntent(
    owner: SpeakingAudioUploadOwner,
    intent: SpeakingAudioUploadIntent,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const stagingKey = speakingAudioStagingObjectKey(
      intent.organizationId,
      intent.assetId,
    );
    try {
      const outcomes = await Promise.allSettled([
        this.storage.deleteObject(
          { environment: intent.environment, objectKey: intent.objectKey },
          signal,
        ),
        this.storage.deleteObject(
          { environment: intent.environment, objectKey: stagingKey },
          signal,
        ),
      ]);
      if (outcomes.every((outcome) => outcome.status === 'fulfilled')) {
        await this.repository.removeRejectedIntent(owner);
      }
    } catch {
      // The rejected intent remains durable so a later sweep can retry.
    }
  }

  private async deleteStagingBestEffort(
    intent: SpeakingAudioUploadIntent,
    stagingKey: string,
  ): Promise<void> {
    try {
      await this.storage.deleteObject({
        environment: intent.environment,
        objectKey: stagingKey,
      });
    } catch {
      // Completion is durable; staging cleanup is best effort.
    }
  }
}
