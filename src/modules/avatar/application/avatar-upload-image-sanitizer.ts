import { invalidRequest } from '@/common/errors/invalid-request';
import { payloadTooLarge, uploadNotFound } from '@/common/errors/upload-errors';
import {
  reserveRasterImageProcessing,
  sanitizeRasterImage,
  serializeRasterImageProcessing,
} from '@/common/image/raster-image';
import {
  AVATAR_COMPLETION_WINDOW_MS,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_PIXELS,
  type AvatarContentType,
  avatarObjectKey,
} from '@/modules/avatar/domain/avatar';
import type { AvatarStoragePort } from './avatar-storage.port';

export interface SanitizedAvatarUpload {
  readonly objectKey: string;
  readonly contentType: AvatarContentType;
  readonly bytes: Uint8Array;
  release(): void;
}

type SharedSanitizedAvatarUpload = Omit<SanitizedAvatarUpload, 'release'> & {
  acquire(): () => void;
};

type ValidatedStagingObject = {
  readonly contentType: AvatarContentType;
  readonly byteSize: number;
};

export class AvatarUploadImageSanitizer {
  private readonly pending = new Map<
    string,
    Promise<SharedSanitizedAvatarUpload>
  >();

  constructor(
    private readonly storage: AvatarStoragePort,
    private readonly validateStored: (
      object: {
        readonly contentType: string | undefined;
        readonly byteSize: number | undefined;
      },
      objectKey: string,
      signal: AbortSignal | undefined,
      staging: boolean,
    ) => Promise<ValidatedStagingObject>,
    private readonly discardStaging: (
      objectKey: string,
      signal?: AbortSignal,
    ) => Promise<void>,
    private readonly now: () => Date,
  ) {}

  async sanitizeOnce(
    userId: string,
    assetId: string,
    signal: AbortSignal,
  ): Promise<SanitizedAvatarUpload> {
    const key = `${userId}:${assetId}`;
    let sanitization = this.pending.get(key);
    if (sanitization === undefined) {
      sanitization = this.sanitize(userId, assetId, signal, () => {
        if (this.pending.get(key) === sanitization) this.pending.delete(key);
      });
      this.pending.set(key, sanitization);
    }
    try {
      const shared = await sanitization;
      return {
        objectKey: shared.objectKey,
        contentType: shared.contentType,
        bytes: shared.bytes,
        release: shared.acquire(),
      };
    } catch (error) {
      if (this.pending.get(key) === sanitization) this.pending.delete(key);
      throw error;
    }
  }

  private async sanitize(
    userId: string,
    assetId: string,
    signal: AbortSignal,
    onUnused: () => void,
  ): Promise<SharedSanitizedAvatarUpload> {
    const admission = reserveRasterImageProcessing('avatar');
    try {
      const sanitized = await this.readAndSanitize(
        userId,
        assetId,
        signal,
        admission,
      );
      let consumers = 0;
      return {
        ...sanitized,
        acquire: () => {
          consumers += 1;
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            consumers -= 1;
            if (consumers === 0) {
              admission.release();
              onUnused();
            }
          };
        },
      };
    } catch (error) {
      admission.release();
      throw error;
    }
  }

  private async readAndSanitize(
    userId: string,
    assetId: string,
    signal: AbortSignal,
    admission: ReturnType<typeof reserveRasterImageProcessing>,
  ): Promise<Omit<SanitizedAvatarUpload, 'release'>> {
    const objectKey = avatarObjectKey(userId, assetId);
    const stored = await this.storage.describeStagingObject(objectKey, signal);
    if (stored === undefined) {
      throw uploadNotFound('NOT_FOUND', 'Avatar upload was not found');
    }
    const age =
      stored.lastModified === undefined
        ? undefined
        : this.now().getTime() - stored.lastModified.getTime();
    if (age === undefined || age > AVATAR_COMPLETION_WINDOW_MS) {
      await this.discardStaging(objectKey, signal);
      throw uploadNotFound('NOT_FOUND', 'Avatar upload was not found');
    }

    const stagingObject = await this.validateStored(
      stored,
      objectKey,
      signal,
      true,
    );
    const staged = await this.storage.readStagingObject(
      objectKey,
      stored.etag,
      signal,
    );
    if (staged === undefined) {
      await this.discardStaging(objectKey, signal);
      throw uploadNotFound('NOT_FOUND', 'Avatar upload was not found');
    }
    if (staged.contentType !== stagingObject.contentType) {
      await this.discardStaging(objectKey, signal);
      throw invalidRequest();
    }

    const sanitized = await serializeRasterImageProcessing(
      admission,
      signal,
      () =>
        sanitizeRasterImage({
          contentType: stagingObject.contentType,
          bytes: staged.bytes,
          maxBytes: AVATAR_MAX_BYTES,
          maxPixels: AVATAR_MAX_PIXELS,
        }),
    );
    if (sanitized?.kind !== 'sanitized') {
      await this.discardStaging(objectKey, signal);
      if (sanitized?.kind === 'too_large') {
        throw payloadTooLarge(
          'PAYLOAD_TOO_LARGE',
          'Avatar image is too large after processing; use a smaller image',
        );
      }
      throw invalidRequest();
    }
    return {
      objectKey,
      contentType: stagingObject.contentType,
      bytes: sanitized.bytes,
    };
  }
}
