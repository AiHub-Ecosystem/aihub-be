import { ulid } from 'ulid';

import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import {
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

function payloadTooLarge(): AppError {
  return new AppError({
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Avatar image is larger than 2 MiB',
    retryable: false,
  });
}

function avatarChanged(): AppError {
  return new AppError({
    code: 'AVATAR_CHANGED',
    message: 'The Avatar was changed by another request',
    retryable: false,
  });
}

function uploadNotFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: 'Avatar upload was not found',
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
      throw payloadTooLarge();
    }

    const assetId = `ava_${ulid()}`;
    const signed = await this.storage.createUploadUrl({
      objectKey: avatarObjectKey(input.userId, assetId),
      contentType,
      byteSize,
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
  }): Promise<CompletedAvatar> {
    const completed = await this.recordUpload(input);
    return { ...this.published(completed.avatar), created: completed.created };
  }

  private async recordUpload(input: {
    readonly userId: string;
    readonly assetId: string;
  }): Promise<{ readonly avatar: Avatar; readonly created: boolean }> {
    if (!isAvatarAssetId(input.assetId)) {
      throw invalidRequest();
    }

    const previous = await this.avatars.findByUser(input.userId);
    if (previous?.assetId === input.assetId) {
      return { avatar: previous, created: false };
    }

    const avatar = await this.verifiedUpload(input.userId, input.assetId);

    if (previous === undefined) {
      const result = await this.avatars.record(avatar);
      if (result.kind === 'exists') {
        await this.discard(avatar.objectKey);
        throw avatarChanged();
      }
      return { avatar: result.avatar, created: result.kind === 'recorded' };
    }

    // Deleted before the record stops naming it: if this fails, nothing has
    // changed, and retrying the completion retries the delete.
    await this.storage.deleteObject(previous.objectKey);
    if (await this.avatars.replace(previous.assetId, avatar)) {
      return { avatar, created: true };
    }

    // Lost to another change. A concurrent completion of this same asset is a
    // repeat, and its object is now the Avatar, so it must not be discarded.
    const current = await this.avatars.findByUser(input.userId);
    if (current?.assetId === input.assetId) {
      return { avatar: current, created: false };
    }
    await this.discard(avatar.objectKey);
    throw avatarChanged();
  }

  async removeAvatar(userId: string): Promise<void> {
    const current = await this.avatars.findByUser(userId);
    if (current === undefined) {
      return;
    }

    // The object goes first: a failed delete leaves the Avatar as it was.
    await this.storage.deleteObject(current.objectKey);
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

  /** Checks what landed against the rules, discarding a refused object. */
  private async verifiedUpload(
    userId: string,
    assetId: string,
  ): Promise<Avatar> {
    const objectKey = avatarObjectKey(userId, assetId);
    const stored = await this.storage.describeObject(objectKey);
    if (stored === undefined) {
      throw uploadNotFound();
    }

    // Checked against what landed, not what was declared: storage may not
    // enforce the signed headers, and this is the check that holds either way.
    const { contentType, byteSize } = stored;
    if (byteSize !== undefined && byteSize > AVATAR_MAX_BYTES) {
      await this.discard(objectKey);
      throw payloadTooLarge();
    }
    if (
      !isAvatarContentType(contentType) ||
      byteSize === undefined ||
      byteSize < 1
    ) {
      await this.discard(objectKey);
      throw invalidRequest();
    }

    return {
      assetId,
      userId,
      objectKey,
      contentType,
      byteSize,
      acceptedAt: this.now(),
    };
  }

  /** Best-effort: a failed delete never changes why the upload was refused. */
  private async discard(objectKey: string): Promise<void> {
    await this.storage.deleteObject(objectKey).catch(() => undefined);
  }
}
