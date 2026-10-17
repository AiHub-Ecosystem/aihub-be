import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import type { IdMinter } from '@/common/ids/prefixed-id';
import type { RequestContext } from '@/common/request-context/request-context';
import {
  type WritingChartUploadIntent,
  isWritingChartAssetId,
  isWritingChartContentType,
  writingChartPublishedKey,
  writingChartStagingKey,
} from '@/modules/writing/domain/writing-chart-upload';
import { serializeWritingChartImageProcessing } from './writing-chart-image-processing';
import { sanitizeWritingChartImage } from './writing-chart-image-verifier';
import {
  WRITING_CHART_INTENT_TTL_MS,
  WRITING_CHART_MAX_BYTES,
  WRITING_CHART_RATE_WINDOW_MS,
} from './writing-chart-upload.policy';
import type {
  WritingChartUploadOwner,
  WritingChartUploadRepositoryPort,
  WritingChartUploadServicePort,
  WritingChartUploadStoragePort,
} from './writing-chart-upload.port';

function storageUnavailable(cause?: unknown): AppError {
  return new AppError({
    code: 'WRITING_CHART_STORAGE_UNAVAILABLE',
    message: 'Writing chart storage is unavailable',
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

function uploadNotFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: 'Writing chart upload was not found',
    retryable: false,
  });
}

function rateLimited(): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Writing chart upload limit reached; retry later',
    retryable: true,
    retryAfterMs: WRITING_CHART_RATE_WINDOW_MS,
    retryAfterHeader: true,
  });
}

function payloadTooLarge(): AppError {
  return new AppError({
    code: 'PAYLOAD_TOO_LARGE',
    message:
      'Writing chart upload or sanitized output must be 10 MiB or smaller',
    retryable: false,
  });
}

function ownerFromContext(
  context: RequestContext,
  assetId: string,
): WritingChartUploadOwner {
  const { organizationId, userId, environment } = context;
  if (
    organizationId === undefined ||
    userId === undefined ||
    (environment !== 'production' && environment !== 'sandbox')
  ) {
    throw storageUnavailable();
  }
  return {
    assetId,
    organizationId,
    endUserId: userId,
    environment,
  };
}

function invalidStoredObject(
  stored: Awaited<ReturnType<WritingChartUploadStoragePort['inspectObject']>>,
  intent: WritingChartUploadIntent,
): AppError | undefined {
  if (
    stored?.byteSize !== undefined &&
    stored.byteSize > WRITING_CHART_MAX_BYTES
  ) {
    return payloadTooLarge();
  }
  if (
    stored === undefined ||
    stored.byteSize !== intent.byteSize ||
    stored.contentType !== intent.contentType ||
    stored.bytes.byteLength !== stored.byteSize
  ) {
    return invalidRequest();
  }
  return undefined;
}

const completionTailsByAsset = new Map<string, Promise<void>>();

function serializeWritingChartUploadCompletion<T>(
  assetId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = completionTailsByAsset.get(assetId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  completionTailsByAsset.set(assetId, tail);
  void tail.then(() => {
    if (completionTailsByAsset.get(assetId) === tail) {
      completionTailsByAsset.delete(assetId);
    }
    return undefined;
  });
  return result;
}

export class WritingChartUploadService
  implements WritingChartUploadServicePort
{
  constructor(
    private readonly repository: WritingChartUploadRepositoryPort,
    private readonly storage: WritingChartUploadStoragePort,
    private readonly newAssetId: IdMinter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }) {
    if (!isWritingChartContentType(input.contentType)) throw invalidRequest();
    if (!Number.isInteger(input.byteSize) || input.byteSize < 1) {
      throw invalidRequest();
    }
    if (input.byteSize > WRITING_CHART_MAX_BYTES) throw payloadTooLarge();

    const createdAt = this.now();
    const assetId = this.newAssetId(createdAt);
    const owner = ownerFromContext(input.context, assetId);
    const intent: WritingChartUploadIntent = {
      assetId,
      organizationId: owner.organizationId,
      endUserId: owner.endUserId,
      environment: owner.environment,
      stagingKey: writingChartStagingKey(assetId),
      publishedKey: writingChartPublishedKey(assetId),
      contentType: input.contentType,
      byteSize: input.byteSize,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + WRITING_CHART_INTENT_TTL_MS),
      status: 'open',
    };
    const signed = await this.storage.createUploadUrl({
      environment: owner.environment,
      stagingKey: intent.stagingKey,
      contentType: intent.contentType,
      byteSize: intent.byteSize,
    });
    if (!(await this.repository.createIntent(intent))) throw rateLimited();

    return {
      assetId,
      contentType: intent.contentType,
      byteSize: intent.byteSize,
      uploadUrl: signed.url,
      uploadFields: signed.fields,
      uploadUrlExpiresAt: signed.expiresAt,
      intentExpiresAt: intent.expiresAt,
    };
  }

  async refresh(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }) {
    if (!isWritingChartAssetId(input.assetId)) throw invalidRequest();
    const owner = ownerFromContext(input.context, input.assetId);
    const found = await this.repository.findUpload(owner);
    const now = this.now();
    if (
      found.kind !== 'intent' ||
      found.intent.status !== 'open' ||
      found.intent.expiresAt.getTime() <= now.getTime()
    ) {
      throw uploadNotFound();
    }

    const signed = await this.storage.createUploadUrl({
      environment: found.intent.environment,
      stagingKey: found.intent.stagingKey,
      contentType: found.intent.contentType,
      byteSize: found.intent.byteSize,
    });
    // A signed URL can outlive the intent it was issued for; re-read before
    // handing it back so a completed or expired upload cannot be refreshed.
    const stillOpen = await this.repository.findUpload(owner);
    if (
      stillOpen.kind !== 'intent' ||
      stillOpen.intent.status !== 'open' ||
      stillOpen.intent.expiresAt.getTime() <= this.now().getTime()
    ) {
      throw uploadNotFound();
    }
    return {
      assetId: found.intent.assetId,
      contentType: found.intent.contentType,
      byteSize: found.intent.byteSize,
      uploadUrl: signed.url,
      uploadFields: signed.fields,
      uploadUrlExpiresAt: signed.expiresAt,
      intentExpiresAt: found.intent.expiresAt,
    };
  }

  async complete(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }) {
    if (!isWritingChartAssetId(input.assetId)) throw invalidRequest();
    const owner = ownerFromContext(input.context, input.assetId);
    return serializeWritingChartUploadCompletion(owner.assetId, async () => {
      const found = await this.repository.findUpload(owner);
      if (found.kind === 'asset') return found.asset;
      const now = this.now();
      if (
        found.kind !== 'intent' ||
        (found.intent.status !== 'open' &&
          found.intent.status !== 'publishing') ||
        found.intent.expiresAt.getTime() <= now.getTime()
      ) {
        throw uploadNotFound();
      }

      const stored = await this.storage.inspectObject(
        {
          environment: found.intent.environment,
          stagingKey: found.intent.stagingKey,
          byteSize: found.intent.byteSize,
        },
        input.context.signal,
      );
      if (stored === undefined) throw uploadNotFound();
      const refusal = invalidStoredObject(stored, found.intent);
      const sanitized =
        refusal === undefined
          ? await serializeWritingChartImageProcessing(() =>
              sanitizeWritingChartImage({
                contentType: found.intent.contentType,
                bytes: stored.bytes,
              }),
            )
          : undefined;
      const sanitizedBytes =
        sanitized?.kind === 'sanitized' ? sanitized.bytes : undefined;
      if (refusal !== undefined || sanitizedBytes === undefined) {
        await this.repository.rejectIntent(owner, this.now());
        try {
          await this.storage.deleteStagingObject(
            {
              environment: found.intent.environment,
              stagingKey: found.intent.stagingKey,
            },
            input.context.signal,
          );
        } catch {
          // The expiration sweep retries a failed staging deletion.
        }
        throw (
          refusal ??
          (sanitized?.kind === 'too_large'
            ? payloadTooLarge()
            : invalidRequest())
        );
      }

      const imageUrl = this.storage.publicUrl({
        environment: found.intent.environment,
        publishedKey: found.intent.publishedKey,
      });
      const reservation = await this.repository.beginPublication({
        owner,
        now: this.now(),
      });
      if (reservation === 'published') {
        const current = await this.repository.findUpload(owner);
        if (current.kind === 'asset') return current.asset;
        throw uploadNotFound();
      }
      if (reservation === 'limited') throw rateLimited();
      if (reservation !== 'started') throw uploadNotFound();

      try {
        await this.storage.publishObject(
          {
            environment: found.intent.environment,
            stagingKey: found.intent.stagingKey,
            publishedKey: found.intent.publishedKey,
            contentType: found.intent.contentType,
            bytes: sanitizedBytes,
          },
          input.context.signal,
        );
      } catch (error) {
        await this.repository.releasePublication(owner);
        throw error;
      }

      const asset = await this.repository.markPublished({
        owner,
        now: this.now(),
        imageUrl,
      });
      if (asset === undefined) throw storageUnavailable();
      try {
        await this.storage.deleteStagingObject(
          {
            environment: found.intent.environment,
            stagingKey: found.intent.stagingKey,
          },
          input.context.signal,
        );
      } catch {
        // The retention sweep retries staging deletion while the public asset lives.
      }
      return asset;
    });
  }
}
