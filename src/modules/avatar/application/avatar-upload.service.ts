import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import { payloadTooLarge, uploadNotFound } from '@/common/errors/upload-errors';
import type { IdMinter } from '@/common/ids/prefixed-id';
import {
  AVATAR_COMPLETION_WINDOW_MS,
  AVATAR_MAX_BYTES,
  type Avatar,
  type AvatarContentType,
  avatarObjectKey,
  isAvatarAssetId,
  isAvatarContentType,
} from '@/modules/avatar/domain/avatar';

import type { AvatarRepositoryPort } from './avatar-repository.port';
import type { AvatarStoragePort } from './avatar-storage.port';

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
    const signed = await this.storage.createUploadUrl({
      objectKey: avatarObjectKey(input.userId, assetId),
      contentType,
    });
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
    readonly signal?: AbortSignal;
  }): Promise<CompletedAvatar> {
    const completed = await this.avatars.withUserLock(input.userId, (avatars) =>
      this.recordUpload(input, avatars),
    );
    if (completed.created) {
      await this.discardStaging(completed.avatar.objectKey, input.signal);
    }
    return { ...this.published(completed.avatar), created: completed.created };
  }

  private async recordUpload(
    input: {
      readonly userId: string;
      readonly assetId: string;
      readonly signal?: AbortSignal;
    },
    avatars: AvatarRepositoryPort,
  ): Promise<{ readonly avatar: Avatar; readonly created: boolean }> {
    if (!isAvatarAssetId(input.assetId)) {
      throw invalidRequest();
    }

    const previous = await avatars.findByUser(input.userId);
    if (previous?.assetId === input.assetId) {
      return { avatar: previous, created: false };
    }

    const avatar = await this.verifiedUpload(
      input.userId,
      input.assetId,
      input.signal,
    );

    if (previous === undefined) {
      const result = await avatars.record(avatar);
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
    if (await avatars.replace(previous.assetId, avatar)) {
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

  async removeAvatar(userId: string, signal?: AbortSignal): Promise<void> {
    const current = await this.avatars.findByUser(userId);
    if (current === undefined) {
      return;
    }

    // The object goes first: a failed delete leaves the Avatar as it was.
    await this.storage.deleteObject(current.objectKey, signal);
    if (await this.avatars.remove(userId, current.assetId)) {
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

  /** Checks private staging, copies, then checks the unwriteable published key. */
  private async verifiedUpload(
    userId: string,
    assetId: string,
    signal?: AbortSignal,
  ): Promise<Avatar> {
    const objectKey = avatarObjectKey(userId, assetId);
    const stored = await this.storage.describeObject(objectKey, signal);
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

    // The private bucket prevents a writable oversized object from being served publicly before completion.
    const stagingObject = await this.validateStored(
      stored,
      objectKey,
      signal,
      true,
    );
    await this.storage.copyStagingToFinal({
      objectKey,
      contentType: stagingObject.contentType,
      ...(signal === undefined ? {} : { signal }),
    });
    const published = await this.storage.describeFinalObject(objectKey, signal);
    if (published === undefined) {
      await this.discard(objectKey, signal);
      await this.discardStaging(objectKey, signal);
      throw uploadNotFound('NOT_FOUND', 'Avatar upload was not found');
    }
    const finalObject = await this.validateStored(
      published,
      objectKey,
      signal,
      false,
    );
    return {
      assetId,
      userId,
      objectKey,
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
