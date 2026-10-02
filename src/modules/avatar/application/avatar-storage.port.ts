import type { AvatarContentType } from '@/modules/avatar/domain/avatar';

export interface AvatarUploadUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

/** What actually landed in storage, as storage reports it. */
export interface StoredAvatarObject {
  readonly contentType: string | undefined;
  readonly byteSize: number | undefined;
  /** Storage's own clock; `undefined` when storage does not report it. */
  readonly lastModified: Date | undefined;
}

export interface ListedAvatarObject {
  readonly objectKey: string;
  readonly lastModified: Date | undefined;
}

/**
 * Object storage for Avatars. Every method fails with
 * `AVATAR_STORAGE_UNAVAILABLE` when storage is unconfigured or unreachable.
 */
export interface AvatarStoragePort {
  /**
   * A short-lived URL that writes exactly one object, with its content type,
   * length, and cache header bound into the signature.
   */
  createUploadUrl(input: {
    readonly objectKey: string;
    readonly contentType: AvatarContentType;
    readonly byteSize: number;
  }): Promise<AvatarUploadUrl>;
  /**
   * The published, unsigned origin URL of an object (ADR-0069). Throws
   * `AVATAR_STORAGE_UNAVAILABLE` when storage is unconfigured.
   */
  publicUrl(objectKey: string): string;
  /** `undefined` when no object exists at the key. */
  describeObject(objectKey: string): Promise<StoredAvatarObject | undefined>;
  deleteObject(objectKey: string): Promise<void>;
  /** Every object under the prefix, across however many pages storage needs. */
  listObjects(prefix: string): AsyncIterable<ListedAvatarObject>;
}

export const AVATAR_STORAGE = Symbol('AVATAR_STORAGE');
