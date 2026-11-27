import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import {
  payloadTooLarge,
  storageUnavailable,
  uploadNotFound,
} from '@/common/errors/upload-errors';
import {
  RasterImageProcessingAbortedError,
  type RasterImageProcessingAdmission,
  RasterImageProcessingCapacityError,
} from '@/common/image/raster-image';
import {
  type UploadSessionPolicy,
  type UploadSessionVerificationPort,
  byteEqualityRefusal,
} from '@/modules/uploads/public';
import {
  type WritingChartContentType,
  type WritingChartEnvironment,
  isWritingChartAssetId,
  isWritingChartContentType,
  isWritingChartEnvironment,
  writingChartPublishedKey,
  writingChartStagingKey,
} from '@/modules/writing/chart-uploads/domain/writing-chart-upload';
import { serializeWritingChartImageProcessing } from './writing-chart-image-processing';
import { sanitizeWritingChartImage } from './writing-chart-image-verifier';
import {
  WRITING_CHART_INTENT_TTL_MS,
  WRITING_CHART_MAX_BYTES,
  WRITING_CHART_ORPHAN_GRACE_MS,
  WRITING_CHART_RATE_WINDOW_MS,
  reserveWritingChartRasterImageProcessing,
} from './writing-chart-upload.policy';

function rateLimited(): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Writing chart upload limit reached; retry later',
    retryable: true,
    retryAfterMs: WRITING_CHART_RATE_WINDOW_MS,
  });
}

function rasterCapacityReached(): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Writing chart image processing is busy; retry shortly',
    retryable: true,
    retryAfterMs: 1_000,
  });
}

function chartPayloadTooLarge(): AppError {
  return payloadTooLarge(
    'PAYLOAD_TOO_LARGE',
    'Writing chart image is larger than 2 MiB',
  );
}

function chartStorageUnavailable(message?: string): AppError {
  return storageUnavailable(
    'WRITING_CHART_STORAGE_UNAVAILABLE',
    message ?? 'Writing chart storage is unavailable',
  );
}

export function writingChartUploadSessionPolicy(): UploadSessionPolicy<
  WritingChartContentType,
  WritingChartEnvironment
> {
  return {
    maxBytes: WRITING_CHART_MAX_BYTES,
    intentTtlMs: WRITING_CHART_INTENT_TTL_MS,
    rateWindowMs: WRITING_CHART_RATE_WINDOW_MS,
    orphanGraceMs: WRITING_CHART_ORPHAN_GRACE_MS,
    owner: (context, assetId) => {
      const { organizationId, userId, environment } = context;
      if (
        organizationId === undefined ||
        userId === undefined ||
        environment === undefined ||
        !isWritingChartEnvironment(environment)
      ) {
        throw chartStorageUnavailable();
      }
      return { assetId, organizationId, endUserId: userId, environment };
    },
    isContentType: (value) => isWritingChartContentType(value),
    isAssetId: (value) => isWritingChartAssetId(value),
    stagingKey: (owner) => writingChartStagingKey(owner.assetId),
    publishedKey: (owner) => writingChartPublishedKey(owner.assetId),
    invalidRequest: () => invalidRequest(),
    payloadTooLarge: chartPayloadTooLarge,
    rateLimited: () => rateLimited(),
    storageUnavailable: (message) => chartStorageUnavailable(message),
    notFound: () =>
      uploadNotFound('NOT_FOUND', 'Writing chart upload was not found'),
  };
}

/** Writing's storage reads staged bytes, so it supplies byte verification. */
export function writingChartUploadVerification(): UploadSessionVerificationPort<
  WritingChartContentType,
  WritingChartEnvironment
> {
  return {
    reserveVerification: () => {
      try {
        return reserveWritingChartRasterImageProcessing();
      } catch (error) {
        if (error instanceof RasterImageProcessingCapacityError) {
          throw rasterCapacityReached();
        }
        throw error;
      }
    },
    verify: async ({ contentType, bytes, signal, lease }) => {
      try {
        return await serializeWritingChartImageProcessing(
          lease as RasterImageProcessingAdmission,
          signal,
          () =>
            sanitizeWritingChartImage({
              contentType,
              bytes,
            }),
        );
      } catch (error) {
        if (error instanceof RasterImageProcessingAbortedError) {
          throw chartStorageUnavailable();
        }
        throw error;
      }
    },
    invalidStoredObject: (stored, intent) =>
      byteEqualityRefusal(stored, intent, {
        maxBytes: WRITING_CHART_MAX_BYTES,
        invalidRequest: () => invalidRequest(),
        payloadTooLarge: chartPayloadTooLarge,
      }),
  };
}
