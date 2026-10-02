import type { AvatarContentType } from '@/modules/avatar/domain/avatar';

export interface AvatarUploadUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

/** What actually landed in storage, as storage reports it. */
export interface StoredAvatarObject {
  readonly contentType: string | undefined;
  readonly byteSize: number | undefined;
}

/**
 * Object storage for Avatars. Every method fails with
 * `AVATAR_STORAGE_UNAVAILABLE` when storage is unconfigured or unreachable.
 */
export interface AvatarStoragePort {
  /**
   * A short-lived URL that writes exactly one object, with its content type
   * and length bound into the signature.
   */
  createUploadUrl(input: {
    readonly objectKey: string;
    readonly contentType: AvatarContentType;
    readonly byteSize: number;
  }): Promise<AvatarUploadUrl>;
  /** `undefined` when no object exists at the key. */
  describeObject(objectKey: string): Promise<StoredAvatarObject | undefined>;
  deleteObject(objectKey: string): Promise<void>;
}

export const AVATAR_STORAGE = Symbol('AVATAR_STORAGE');
