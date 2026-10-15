import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import type { IdMinter } from '@/common/ids/prefixed-id';
import type { RequestContext } from '@/common/request-context/request-context';
import {
  WRITING_CHART_INTENT_TTL_MS,
  WRITING_CHART_MAX_BYTES,
  type WritingChartEnvironment,
  type WritingChartUploadIntent,
  isWritingChartAssetId,
  isWritingChartContentType,
  verifyWritingChartBytes,
  writingChartPublishedKey,
  writingChartStagingKey,
} from '@/modules/writing/domain/writing-chart-upload';
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
    retryAfterMs: 60 * 60 * 1000,
    retryAfterHeader: true,
  });
}

function uploadEnvironment(context: RequestContext): WritingChartEnvironment {
  if (
    context.organizationId === undefined ||
    context.userId === undefined ||
    (context.environment !== 'production' && context.environment !== 'sandbox')
  ) {
    throw storageUnavailable();
  }
  return context.environment;
}

function ownerFromContext(
  context: RequestContext,
  assetId: string,
): WritingChartUploadOwner {
  const environment = uploadEnvironment(context);
  return {
    assetId,
    organizationId: context.organizationId!,
    endUserId: context.userId!,
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
    return new AppError({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Writing chart must be 10 MiB or smaller',
      retryable: false,
    });
  }
  if (
    stored === undefined ||
    stored.byteSize !== intent.byteSize ||
    stored.contentType !== intent.contentType ||
    !verifyWritingChartBytes({
      contentType: intent.contentType,
      byteSize: intent.byteSize,
      prefix: stored.prefix,
      suffix: stored.suffix,
    })
  ) {
    return invalidRequest();
  }
  return undefined;
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
    if (input.byteSize > WRITING_CHART_MAX_BYTES) {
      throw new AppError({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Writing chart must be 10 MiB or smaller',
        retryable: false,
      });
    }

    const environment = uploadEnvironment(input.context);
    const createdAt = this.now();
    const assetId = this.newAssetId(createdAt);
    const intent: WritingChartUploadIntent = {
      assetId,
      organizationId: input.context.organizationId!,
      endUserId: input.context.userId!,
      environment,
      stagingKey: writingChartStagingKey(assetId),
      publishedKey: writingChartPublishedKey(assetId),
      contentType: input.contentType,
      byteSize: input.byteSize,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + WRITING_CHART_INTENT_TTL_MS),
      status: 'open',
    };
    const signed = await this.storage.createUploadUrl({
      environment,
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

    const stored = await this.storage.inspectObject({
      environment: found.intent.environment,
      stagingKey: found.intent.stagingKey,
      byteSize: found.intent.byteSize,
    });
    if (stored === undefined) throw uploadNotFound();
    const refusal = invalidStoredObject(stored, found.intent);
    if (refusal !== undefined) {
      await this.repository.rejectIntent(owner, this.now());
      try {
        await this.storage.deleteStagingObject({
          environment: found.intent.environment,
          stagingKey: found.intent.stagingKey,
        });
      } catch {
        // The expiration sweep retries a failed staging deletion.
      }
      throw refusal;
    }
    if (stored === undefined) throw uploadNotFound();

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
      await this.storage.publishObject({
        environment: found.intent.environment,
        stagingKey: found.intent.stagingKey,
        publishedKey: found.intent.publishedKey,
        contentType: found.intent.contentType,
        etag: stored.etag,
      });
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
      await this.storage.deleteStagingObject({
        environment: found.intent.environment,
        stagingKey: found.intent.stagingKey,
      });
    } catch {
      // The retention sweep retries staging deletion while the public asset lives.
    }
    return asset;
  }
}
