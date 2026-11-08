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
  /** ETag from storage; used to bind the copy source so a replayed PUT cannot swap bytes. */
  readonly etag?: string | undefined;
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
   * A short-lived URL that signs the object's content type and cache header.
   * Completion verifies the size that actually landed.
   */
  createUploadUrl(input: {
    readonly objectKey: string;
    readonly contentType: AvatarContentType;
  }): Promise<AvatarUploadUrl>;
  copyStagingToFinal(input: {
    readonly objectKey: string;
    readonly contentType: AvatarContentType;
    readonly signal?: AbortSignal;
    /** Binds the copy source by ETag so a replayed PUT cannot swap bytes. */
    readonly stagingEtag?: string | undefined;
  }): Promise<void>;
  /**
   * The published, unsigned origin URL of an object (ADR-0069). Throws
   * `AVATAR_STORAGE_UNAVAILABLE` when storage is unconfigured.
   */
  publicUrl(objectKey: string): string;
  /** `undefined` when no object exists at the key. */
  describeStagingObject(
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<StoredAvatarObject | undefined>;
  describeFinalObject(
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<StoredAvatarObject | undefined>;
  deleteObject(objectKey: string, signal?: AbortSignal): Promise<void>;
  deleteStagingObject(objectKey: string, signal?: AbortSignal): Promise<void>;
  /** Every object under the prefix, across however many pages storage needs. */
  listObjects(prefix: string): AsyncIterable<ListedAvatarObject>;
  listStagingObjects(prefix: string): AsyncIterable<ListedAvatarObject>;
}

export const AVATAR_STORAGE = Symbol('AVATAR_STORAGE');
