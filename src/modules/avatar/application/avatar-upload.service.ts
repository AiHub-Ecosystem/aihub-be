import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import { payloadTooLarge, uploadNotFound } from '@/common/errors/upload-errors';
import type { IdMinter } from '@/common/ids/prefixed-id';
import {
  sanitizeRasterImage,
  serializeRasterImageProcessing,
} from '@/common/image/raster-image';
import { recordRejected } from '@/common/observability/rejected-metric';
import {
  AVATAR_COMPLETION_WINDOW_MS,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_PIXELS,
  type Avatar,
  type AvatarContentType,
  avatarObjectKey,
  isAvatarAssetId,
  isAvatarContentType,
} from '@/modules/avatar/domain/avatar';

import type {
  AvatarAuditEvent,
  AvatarRepositoryPort,
} from './avatar-repository.port';
import type { AvatarStoragePort } from './avatar-storage.port';
import {
  AVATAR_COMPLETION_COPY_MIN_REMAINING_MS,
  AVATAR_COMPLETION_DEADLINE_MS,
  AVATAR_OPEN_UPLOAD_MAX,
  AVATAR_UPLOAD_ISSUANCE_MAX,
  AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
} from './avatar-upload.policy';

export interface AvatarUpload {
  readonly assetId: string;
  readonly uploadUrl: string;
  readonly contentType: AvatarContentType;
  readonly byteSize: number;
  readonly expiresAt: Date;
}

/** An Avatar with the published URL it is read from (ADR-0069). */
export interface PublishedAvatar {
  readonly avatar: Avatar;
  readonly url: string;
}

interface SanitizedAvatarUpload {
  readonly objectKey: string;
  readonly contentType: AvatarContentType;
  readonly bytes: Uint8Array;
}

export interface CompletedAvatar extends PublishedAvatar {
  /** `false` when an earlier completion of the same asset recorded it. */
  readonly created: boolean;
}

function avatarChanged(): AppError {
  return new AppError({
    code: 'AVATAR_CHANGED',
    message: 'The Avatar was changed by another request',
    retryable: false,
  });
}

function avatarStorageUnavailable(): AppError {
  return new AppError({
    code: 'AVATAR_STORAGE_UNAVAILABLE',
    message: 'Avatar storage is unavailable',
    retryable: true,
  });
}

/**
 * Sets, replaces, and removes the one Avatar an account holds (ADR-0068).
 *
 * No upload intent is stored: completion rebuilds the key from the
 * authenticated account. A previous object is always deleted before the
 * record stops naming it, so a failed delete changes nothing and a retry
 * finishes the job; every record change is conditional on the Avatar this
 * request read, so a concurrent change is reported rather than overwritten.
 */
export class AvatarUploadService {
  constructor(
    private readonly avatars: AvatarRepositoryPort,
    private readonly storage: AvatarStoragePort,
    private readonly newAssetId: IdMinter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async requestUpload(input: {
    readonly userId: string;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<AvatarUpload> {
    const { contentType, byteSize } = input;
    if (!isAvatarContentType(contentType) || !Number.isInteger(byteSize)) {
      throw invalidRequest();
    }
    if (byteSize > AVATAR_MAX_BYTES) {
      throw payloadTooLarge(
        'PAYLOAD_TOO_LARGE',
        'Avatar image is larger than 2 MiB',
      );
    }

    const assetId = this.newAssetId(this.now());
    const objectKey = avatarObjectKey(input.userId, assetId);
    const signed = await this.storage.createUploadUrl({
      objectKey,
      contentType,
    });

    // The URL is a write credential for one object, so it is recorded before
    // it is handed out: an account holds a bounded number at once and is issued
    // a bounded number per window (#374). Signing the URL first costs nothing
    // because the grant has to record the signature's own expiry, and a
    // refused signature is never returned.
    const granted = await this.avatars.grantUpload(
      {
        userId: input.userId,
        assetId,
        objectKey,
        expiresAt: signed.expiresAt,
        createdAt: this.now(),
      },
      {
        openLimit: AVATAR_OPEN_UPLOAD_MAX,
        issuanceLimit: AVATAR_UPLOAD_ISSUANCE_MAX,
        issuanceWindowMs: AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
      },
    );
    if (!granted) {
      recordRejected('rate_limit');
      throw new AppError({
        code: 'RATE_LIMITED',
        message: 'Avatar upload limit reached; retry later',
        retryable: true,
        retryAfterMs: AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
      });
    }

    return {
      assetId,
      uploadUrl: signed.url,
      contentType,
      byteSize,
      expiresAt: signed.expiresAt,
    };
  }

  /**
   * `undefined` when the account has no Avatar, without touching storage: an
   * outage must never turn an empty account into an error.
   */
  async readAvatar(userId: string): Promise<PublishedAvatar | undefined> {
    const avatar = await this.avatars.findByUser(userId);
    return avatar === undefined ? undefined : this.published(avatar);
  }

  async completeUpload(input: {
    readonly userId: string;
    readonly assetId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<CompletedAvatar> {
    const deadlineAt = performance.now() + AVATAR_COMPLETION_DEADLINE_MS;
    const deadline = AbortSignal.timeout(AVATAR_COMPLETION_DEADLINE_MS);
    const signal =
      input.signal === undefined
        ? deadline
        : AbortSignal.any([input.signal, deadline]);
    const completion = { ...input, signal, deadlineAt };
    if (!isAvatarAssetId(input.assetId)) {
      throw invalidRequest();
    }
    const current = await this.avatars.findByUser(input.userId);
    if (current?.assetId === input.assetId) {
      await this.avatars.consumeUploadGrant(input.userId, input.assetId);
      return { ...this.published(current), created: false };
    }
    const sanitized = await this.sanitizeUpload(
      input.userId,
      input.assetId,
      signal,
    );
    const completed = await this.avatars.withUserLock(input.userId, (avatars) =>
      this.recordUpload(completion, sanitized, avatars),
    );
    // A consumed grant stops holding a slot whether this request created the
    // record or found it already recorded by a concurrent completion.
    await this.avatars.consumeUploadGrant(input.userId, input.assetId);
    if (completed.created) {
      await this.discardStaging(completed.avatar.objectKey, signal);
    }
    return { ...this.published(completed.avatar), created: completed.created };
  }

  private async recordUpload(
    input: {
      readonly userId: string;
      readonly assetId: string;
      readonly requestId: string;
      readonly signal: AbortSignal;
      readonly deadlineAt: number;
    },
    sanitized: SanitizedAvatarUpload,
    avatars: AvatarRepositoryPort,
  ): Promise<{ readonly avatar: Avatar; readonly created: boolean }> {
    const previous = await avatars.findByUser(input.userId);
    if (previous?.assetId === input.assetId) {
      return { avatar: previous, created: false };
    }

    const avatar = await this.publishUpload(
      sanitized,
      input.userId,
      input.assetId,
      input.signal,
      input.deadlineAt,
    );

    if (previous === undefined) {
      const result = await avatars.record(
        avatar,
        this.audit('avatar.set', avatar, input.requestId),
      );
      if (result.kind === 'exists') {
        await this.discard(avatar.objectKey, input.signal);
        await this.discardStaging(avatar.objectKey, input.signal);
        throw avatarChanged();
      }
      return { avatar: result.avatar, created: result.kind === 'recorded' };
    }

    // Deleted before the record stops naming it: if this fails, nothing has
    // changed, and retrying the completion retries the delete.
    await this.storage.deleteObject(previous.objectKey, input.signal);
    if (
      await avatars.replace(
        previous.assetId,
        avatar,
        this.audit('avatar.replaced', avatar, input.requestId),
      )
    ) {
      return { avatar, created: true };
    }

    // Lost to another change. A concurrent completion of this same asset is a
    // repeat, and its object is now the Avatar, so it must not be discarded.
    const current = await avatars.findByUser(input.userId);
    if (current?.assetId === input.assetId) {
      await this.discardStaging(avatar.objectKey, input.signal);
      return { avatar: current, created: false };
    }
    await this.discard(avatar.objectKey, input.signal);
    await this.discardStaging(avatar.objectKey, input.signal);
    throw avatarChanged();
  }

  async removeAvatar(input: {
    readonly userId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const { userId, signal } = input;
    const current = await this.avatars.findByUser(userId);
    if (current === undefined) {
      return;
    }

    // The object goes first: a failed delete leaves the Avatar as it was.
    await this.storage.deleteObject(current.objectKey, signal);
    if (
      await this.avatars.remove(
        userId,
        current.assetId,
        this.audit('avatar.removed', current, input.requestId),
      )
    ) {
      return;
    }

    // Another request changed it. Gone is what was asked for; a different
    // Avatar swapped in meanwhile is not this request's to delete.
    if ((await this.avatars.findByUser(userId)) !== undefined) {
      throw avatarChanged();
    }
  }

  private published(avatar: Avatar): PublishedAvatar {
    return { avatar, url: this.storage.publicUrl(avatar.objectKey) };
  }

  private audit(
    action: AvatarAuditEvent['action'],
    avatar: Avatar,
    requestId: string,
  ): AvatarAuditEvent {
    return {
      action,
      assetId: avatar.assetId,
      requestId,
      occurredAt: this.now(),
    };
  }

  /** Checks and re-encodes staging before opening the Avatar lock transaction. */
  private async sanitizeUpload(
    userId: string,
    assetId: string,
    signal: AbortSignal,
  ): Promise<SanitizedAvatarUpload> {
    const objectKey = avatarObjectKey(userId, assetId);
    const stored = await this.storage.describeStagingObject(objectKey, signal);
    if (stored === undefined) {
      throw uploadNotFound('NOT_FOUND', 'Avatar upload was not found');
    }

    // Older than the window, or of an age storage will not state: the sweep may
    // be about to delete it, and the gap between the two windows is what keeps
    // a completion and a sweep from ever acting on the same object.
    const age =
      stored.lastModified === undefined
        ? undefined
        : this.now().getTime() - stored.lastModified.getTime();
    if (age === undefined || age > AVATAR_COMPLETION_WINDOW_MS) {
      await this.discardStaging(objectKey, signal);
      throw uploadNotFound('NOT_FOUND', 'Avatar upload was not found');
    }

    // The private bucket prevents a writable oversized object from being served
    // publicly before completion.
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

    // Decoding cannot be aborted; queued work must re-check its deadline.
    const sanitized = await serializeRasterImageProcessing(() => {
      if (signal.aborted) throw avatarStorageUnavailable();
      return sanitizeRasterImage({
        contentType: stagingObject.contentType,
        bytes: staged.bytes,
        maxBytes: AVATAR_MAX_BYTES,
        maxPixels: AVATAR_MAX_PIXELS,
      });
    });
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

  private async publishUpload(
    sanitized: SanitizedAvatarUpload,
    userId: string,
    assetId: string,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<Avatar> {
    if (
      signal.aborted ||
      deadlineAt - performance.now() < AVATAR_COMPLETION_COPY_MIN_REMAINING_MS
    )
      throw avatarStorageUnavailable();
    await this.storage.putFinalObject({
      objectKey: sanitized.objectKey,
      contentType: sanitized.contentType,
      bytes: sanitized.bytes,
      signal,
    });
    const published = await this.storage.describeFinalObject(
      sanitized.objectKey,
      signal,
    );
    if (published === undefined) {
      await this.discard(sanitized.objectKey, signal);
      await this.discardStaging(sanitized.objectKey, signal);
      throw uploadNotFound('NOT_FOUND', 'Avatar upload was not found');
    }
    const finalObject = await this.validateStored(
      published,
      sanitized.objectKey,
      signal,
      false,
    );
    return {
      assetId,
      userId,
      objectKey: sanitized.objectKey,
      contentType: finalObject.contentType,
      byteSize: finalObject.byteSize,
      acceptedAt: this.now(),
    };
  }

  private async validateStored(
    stored: {
      readonly contentType: string | undefined;
      readonly byteSize: number | undefined;
    },
    objectKey: string,
    signal: AbortSignal | undefined,
    staging: boolean,
  ): Promise<{
    readonly contentType: AvatarContentType;
    readonly byteSize: number;
  }> {
    const { contentType, byteSize } = stored;
    if (byteSize !== undefined && byteSize > AVATAR_MAX_BYTES) {
      if (staging) await this.discardStaging(objectKey, signal);
      else {
        await this.discard(objectKey, signal);
        await this.discardStaging(objectKey, signal);
      }
      throw payloadTooLarge(
        'PAYLOAD_TOO_LARGE',
        'Avatar image is larger than 2 MiB',
      );
    }
    if (
      !isAvatarContentType(contentType) ||
      byteSize === undefined ||
      byteSize < 1
    ) {
      if (staging) await this.discardStaging(objectKey, signal);
      else {
        await this.discard(objectKey, signal);
        await this.discardStaging(objectKey, signal);
      }
      throw invalidRequest();
    }
    return { contentType, byteSize };
  }

  /** Best-effort: a failed delete never changes why the upload was refused. */
  private async discard(
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.storage.deleteObject(objectKey, signal).catch(() => undefined);
  }

  private async discardStaging(
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.storage
      .deleteStagingObject(objectKey, signal)
      .catch(() => undefined);
  }
}
