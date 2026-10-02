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

export interface CompletedAvatar {
  readonly avatar: Avatar;
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

function avatarExists(): AppError {
  return new AppError({
    code: 'AVATAR_EXISTS',
    message: 'This account already has an Avatar',
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
 * Mints an upload URL and records the Avatar once the upload has landed. No
 * upload intent is stored: completion rebuilds the key from the authenticated
 * account, so nothing exists between the two calls but the object itself.
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
    if ((await this.avatars.findByUser(input.userId)) !== undefined) {
      throw avatarExists();
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

  async completeUpload(input: {
    readonly userId: string;
    readonly assetId: string;
  }): Promise<CompletedAvatar> {
    if (!isAvatarAssetId(input.assetId)) {
      throw invalidRequest();
    }

    const existing = await this.avatars.findByUser(input.userId);
    if (existing !== undefined) {
      if (existing.assetId === input.assetId) {
        return { avatar: existing, created: false };
      }
      throw avatarExists();
    }

    const objectKey = avatarObjectKey(input.userId, input.assetId);
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

    const result = await this.avatars.record({
      assetId: input.assetId,
      userId: input.userId,
      objectKey,
      contentType,
      byteSize,
      acceptedAt: this.now(),
    });
    if (result.kind === 'exists') {
      throw avatarExists();
    }
    return { avatar: result.avatar, created: result.kind === 'recorded' };
  }

  /** Best-effort: a failed delete never changes why the upload was refused. */
  private async discard(objectKey: string): Promise<void> {
    await this.storage.deleteObject(objectKey).catch(() => undefined);
  }
}
