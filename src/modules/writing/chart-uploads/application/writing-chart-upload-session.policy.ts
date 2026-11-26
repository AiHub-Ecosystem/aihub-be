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
import type { UploadSessionPolicy } from '@/modules/uploads/public';
import {
  type WritingChartContentType,
  isWritingChartAssetId,
  isWritingChartContentType,
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

export function writingChartUploadSessionPolicy(): UploadSessionPolicy {
  return {
    maxBytes: WRITING_CHART_MAX_BYTES,
    intentTtlMs: WRITING_CHART_INTENT_TTL_MS,
    rateWindowMs: WRITING_CHART_RATE_WINDOW_MS,
    orphanGraceMs: WRITING_CHART_ORPHAN_GRACE_MS,
    isContentType: (value) => isWritingChartContentType(value),
    isAssetId: (value) => isWritingChartAssetId(value),
    stagingKey: (assetId) => writingChartStagingKey(assetId),
    publishedKey: (assetId) => writingChartPublishedKey(assetId),
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
              contentType: contentType as WritingChartContentType,
              bytes,
            }),
        );
      } catch (error) {
        if (error instanceof RasterImageProcessingAbortedError) {
          throw storageUnavailable(
            'WRITING_CHART_STORAGE_UNAVAILABLE',
            'Writing chart storage is unavailable',
          );
        }
        throw error;
      }
    },
    invalidRequest: () => invalidRequest(),
    payloadTooLarge: () =>
      payloadTooLarge(
        'PAYLOAD_TOO_LARGE',
        'Writing chart image is larger than 2 MiB',
      ),
    rateLimited: () => rateLimited(),
    storageUnavailable: (message) =>
      storageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        message ?? 'Writing chart storage is unavailable',
      ),
    notFound: () =>
      uploadNotFound('NOT_FOUND', 'Writing chart upload was not found'),
  };
}
