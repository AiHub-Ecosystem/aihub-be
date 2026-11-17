import { invalidRequest } from '@/common/errors/invalid-request';
import { payloadTooLarge, uploadNotFound } from '@/common/errors/upload-errors';
import {
  RasterImageProcessingAbortedError,
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
import { reserveAvatarRasterImageProcessing } from './avatar-upload.policy';

export interface SanitizedAvatarUpload {
  readonly objectKey: string;
  readonly contentType: AvatarContentType;
  readonly bytes: Uint8Array;
  release(): void;
}

type SharedSanitizedAvatarUpload = Omit<SanitizedAvatarUpload, 'release'> & {
  releaseAdmission(): void;
};

type PendingSanitization = {
  readonly controller: AbortController;
  promise: Promise<SharedSanitizedAvatarUpload>;
  shared?: SharedSanitizedAvatarUpload;
  waiters: number;
};

type ValidatedStagingObject = {
  readonly contentType: AvatarContentType;
  readonly byteSize: number;
};

export class AvatarUploadImageSanitizer {
  private readonly pending = new Map<string, PendingSanitization>();

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
    if (signal.aborted) throw new RasterImageProcessingAbortedError();
    const key = `${userId}:${assetId}`;
    let pending = this.pending.get(key);
    if (pending === undefined) {
      const controller = new AbortController();
      pending = {
        controller,
        waiters: 0,
        promise: this.sanitize(userId, assetId, controller.signal),
      };
      const current = pending;
      pending.promise = pending.promise
        .then((shared) => {
          current.shared = shared;
          if (current.waiters === 0) {
            shared.releaseAdmission();
            this.removePending(key, current);
          }
          return shared;
        })
        .catch((error: unknown) => {
          this.removePending(key, current);
          throw error;
        });
      this.pending.set(key, current);
    }
    pending.waiters += 1;
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      pending.waiters -= 1;
      if (pending.waiters !== 0) return;
      pending.controller.abort();
      pending.shared?.releaseAdmission();
      this.removePending(key, pending);
    };
    try {
      const shared = await this.waitFor(pending.promise, signal, release);
      return {
        objectKey: shared.objectKey,
        contentType: shared.contentType,
        bytes: shared.bytes,
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async waitFor(
    sanitization: Promise<SharedSanitizedAvatarUpload>,
    signal: AbortSignal,
    release: () => void,
  ): Promise<SharedSanitizedAvatarUpload> {
    if (signal.aborted) {
      release();
      throw new RasterImageProcessingAbortedError();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        settled = true;
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        if (settled) return;
        finish();
        release();
        reject(new RasterImageProcessingAbortedError());
      };
      signal.addEventListener('abort', abort, { once: true });
      sanitization.then(
        (shared) => {
          if (settled) return undefined;
          finish();
          resolve(shared);
          return undefined;
        },
        (error: unknown) => {
          if (settled) return undefined;
          finish();
          reject(error);
          return undefined;
        },
      );
      if (signal.aborted) abort();
    });
  }

  private async sanitize(
    userId: string,
    assetId: string,
    signal: AbortSignal,
  ): Promise<SharedSanitizedAvatarUpload> {
    const admission = reserveAvatarRasterImageProcessing();
    try {
      const sanitized = await this.readAndSanitize(
        userId,
        assetId,
        signal,
        admission,
      );
      return {
        ...sanitized,
        releaseAdmission: () => admission.release(),
      };
    } catch (error) {
      admission.release();
      throw error;
    }
  }

  private removePending(key: string, pending: PendingSanitization): void {
    if (this.pending.get(key) === pending) this.pending.delete(key);
  }

  private async readAndSanitize(
    userId: string,
    assetId: string,
    signal: AbortSignal,
    admission: ReturnType<typeof reserveAvatarRasterImageProcessing>,
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
