import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import { uploadNotFound } from '@/common/errors/upload-errors';
import {
  RasterImageProcessingAbortedError,
  type RasterImageProcessingAdmission,
  RasterImageProcessingCapacityError,
  sanitizeRasterImage,
} from '@/common/image/raster-image';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_PIXELS,
  AVATAR_SWEEP_GRACE_MS,
  AVATAR_UPLOAD_URL_TTL_SECONDS,
  type AvatarContentType,
  avatarObjectKey,
  isAvatarAssetId,
  isAvatarContentType,
} from '@/modules/avatar/domain/avatar';
import type { UploadSessionPolicy } from '@/modules/uploads/public';
import {
  AVATAR_COMPLETION_DEADLINE_MS,
  AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
  reserveAvatarRasterImageProcessing,
} from './avatar-upload.policy';

function rateLimited(): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Avatar upload limit reached; retry later',
    retryable: true,
    retryAfterMs: AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
  });
}

function storageUnavailable(): AppError {
  return new AppError({
    code: 'AVATAR_STORAGE_UNAVAILABLE',
    message: 'Avatar storage is unavailable',
    retryable: true,
  });
}

function payloadTooLarge(): AppError {
  return new AppError({
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Avatar image is larger than 2 MiB',
    retryable: false,
  });
}

export function avatarUploadSessionPolicy(): UploadSessionPolicy {
  return {
    maxBytes: AVATAR_MAX_BYTES,
    intentTtlMs: AVATAR_UPLOAD_URL_TTL_SECONDS * 1000,
    rateWindowMs: AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
    orphanGraceMs: AVATAR_SWEEP_GRACE_MS,
    completionSignal: (signal) =>
      AbortSignal.any([
        signal,
        AbortSignal.timeout(AVATAR_COMPLETION_DEADLINE_MS),
      ]),
    owner: (context, assetId) => {
      if (context.userId === undefined) throw storageUnavailable();
      return {
        assetId,
        endUserId: context.userId,
        environment: 'production',
      };
    },
    isContentType: (value) => isAvatarContentType(value),
    isAssetId: (value) => isAvatarAssetId(value),
    stagingKey: (owner) => avatarObjectKey(owner.endUserId, owner.assetId),
    publishedKey: (owner) => avatarObjectKey(owner.endUserId, owner.assetId),
    reserveVerification: () => {
      try {
        return reserveAvatarRasterImageProcessing();
      } catch (error) {
        if (error instanceof RasterImageProcessingCapacityError) {
          throw new AppError({
            code: 'RATE_LIMITED',
            message: 'Avatar image processing is busy; retry later',
            retryable: true,
            retryAfterMs: 1_000,
          });
        }
        throw error;
      }
    },
    verify: async ({ contentType, bytes, lease }) => {
      try {
        return await sanitizeRasterImage({
          contentType: contentType as AvatarContentType,
          bytes,
          maxBytes: AVATAR_MAX_BYTES,
          maxPixels: AVATAR_MAX_PIXELS,
        });
      } catch (error) {
        if (error instanceof RasterImageProcessingAbortedError) {
          throw storageUnavailable();
        }
        throw error;
      } finally {
        (lease as RasterImageProcessingAdmission).release();
      }
    },
    invalidStoredObject: (stored) => {
      if (stored.byteSize !== undefined && stored.byteSize > AVATAR_MAX_BYTES) {
        return payloadTooLarge();
      }
      if (!isAvatarContentType(stored.contentType)) return invalidRequest();
      return undefined;
    },
    invalidRequest: () => invalidRequest(),
    payloadTooLarge: () => payloadTooLarge(),
    rateLimited: () => rateLimited(),
    storageUnavailable: () => storageUnavailable(),
    notFound: () => uploadNotFound('NOT_FOUND', 'Avatar upload was not found'),
  };
}
