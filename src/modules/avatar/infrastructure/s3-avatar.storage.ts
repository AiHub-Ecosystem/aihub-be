import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { AppError } from '@/common/errors/app-error';
import { DEFAULT_SEAWEEDFS_ENDPOINT } from '@/config/runtime-configuration';
import type {
  AvatarStoragePort,
  AvatarUploadUrl,
  ListedAvatarObject,
  StoredAvatarObject,
} from '@/modules/avatar/application/avatar-storage.port';
import {
  AVATAR_CACHE_CONTROL,
  AVATAR_UPLOAD_URL_TTL_SECONDS,
  type AvatarContentType,
} from '@/modules/avatar/domain/avatar';
import {
  objectStorageNotFound,
  objectStorageSignal,
  objectStorageUnavailable,
} from '@/modules/secrets/public/object-storage';
import {
  AVATAR_STAGING_BUCKETS,
  type AvatarStorageEnvironment,
} from './avatar-storage.policy';
const DEFAULT_ORIGIN = new URL(DEFAULT_SEAWEEDFS_ENDPOINT).origin;

export interface AvatarStorageOptions {
  readonly bucket?: string | undefined;
  readonly stagingBucket?: string | undefined;
  readonly environment?: AvatarStorageEnvironment;
  readonly now?: () => Date;
  /** Replaces the S3 client built from runtime secrets; for tests. */
  readonly client?: Pick<S3Client, 'send'>;
}

function validObjectKey(objectKey: string): boolean {
  return (
    objectKey.startsWith('users/') &&
    objectKey.length <= 1_024 &&
    !objectKey.includes('..') &&
    !/[\s?#]/.test(objectKey)
  );
}

interface Configured {
  readonly client: Pick<S3Client, 'send'>;
  /** Kept apart from `client`: a test client cannot presign. */
  readonly signer: S3Client | undefined;
  readonly bucket: string;
  readonly stagingBucket: string;
  /** The approved origin, without a trailing slash. */
  readonly origin: string;
}

/**
 * Avatars live in their own private bucket (ADR-0068), which must be named
 * explicitly. Without it, or without credentials, every call answers
 * `AVATAR_STORAGE_UNAVAILABLE`; it never falls back to another bucket.
 */
export class S3AvatarStorage implements AvatarStoragePort {
  private readonly configured: Configured | undefined;
  private readonly now: () => Date;

  constructor(
    sharedClient: S3Client | undefined,
    options: AvatarStorageOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const bucket = (options.bucket ?? '').trim();
    const defaultStagingBucket =
      AVATAR_STAGING_BUCKETS[options.environment ?? 'production'];
    const stagingBucket = options.stagingBucket?.trim() || defaultStagingBucket;

    if (
      sharedClient === undefined ||
      bucket.length === 0 ||
      stagingBucket.length === 0 ||
      stagingBucket === bucket
    ) {
      this.configured = undefined;
      return;
    }

    this.configured = {
      client: options.client ?? sharedClient,
      signer: sharedClient,
      bucket,
      stagingBucket,
      origin: DEFAULT_ORIGIN,
    };
  }

  /**
   * Destroys the shared S3Client, releasing its keep-alive agents. CLI sweep
   * commands call this on completion so a cron-driven process drains instead
   * of holding sockets open (#1523). Unconfigured storage has no client. The
   * SDK destroy is synchronous.
   */
  async close(): Promise<void> {
    this.configured?.signer?.destroy();
  }

  async createUploadUrl(input: {
    readonly objectKey: string;
    readonly contentType: AvatarContentType;
  }): Promise<AvatarUploadUrl> {
    const { signer, stagingBucket } = this.requireStaging(input.objectKey);
    if (signer === undefined) {
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
      );
    }
    const expiresAt = new Date(
      this.now().getTime() + AVATAR_UPLOAD_URL_TTL_SECONDS * 1_000,
    );
    try {
      const url = await getSignedUrl(
        signer,
        new PutObjectCommand({
          Bucket: stagingBucket,
          Key: input.objectKey,
          ContentType: input.contentType,
          CacheControl: AVATAR_CACHE_CONTROL,
        }),
        {
          expiresIn: AVATAR_UPLOAD_URL_TTL_SECONDS,
          // Private staging closes public exposure without signing browser-managed Content-Length.
          // Browser Fetch controls Content-Length; completion checks stored size.
          signableHeaders: new Set(['content-type', 'cache-control']),
        },
      );
      return { url, expiresAt };
    } catch (error) {
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
        error,
      );
    }
  }

  publicUrl(objectKey: string): string {
    const { origin, bucket } = this.require(objectKey);
    const path = [bucket, ...objectKey.split('/')]
      .map(encodeURIComponent)
      .join('/');
    return `${origin}/${path}`;
  }

  async copyStagingToFinal(input: {
    readonly objectKey: string;
    readonly contentType: AvatarContentType;
    readonly signal?: AbortSignal;
    readonly stagingEtag?: string | undefined;
  }): Promise<void> {
    const { client, bucket, stagingBucket } = this.requireStaging(
      input.objectKey,
    );
    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: input.objectKey,
          CopySource: `${stagingBucket}/${input.objectKey}`,
          MetadataDirective: 'REPLACE',
          ContentType: input.contentType,
          CacheControl: AVATAR_CACHE_CONTROL,
          ...(input.stagingEtag !== undefined
            ? { CopySourceIfMatch: input.stagingEtag }
            : {}),
        }),
        { abortSignal: input.signal ?? objectStorageSignal() },
      );
    } catch (error) {
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
        error,
        input.signal,
      );
    }
  }

  async describeStagingObject(
    objectKey: string,
    signal = objectStorageSignal(),
  ): Promise<StoredAvatarObject | undefined> {
    const { client, stagingBucket } = this.requireStaging(objectKey);
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: stagingBucket, Key: objectKey }),
        { abortSignal: signal },
      );
      return {
        contentType: head.ContentType,
        byteSize: head.ContentLength,
        lastModified: head.LastModified,
        etag: head.ETag,
      };
    } catch (error) {
      if (objectStorageNotFound(error)) {
        return undefined;
      }
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
        error,
        signal,
      );
    }
  }

  async describeFinalObject(
    objectKey: string,
    signal = objectStorageSignal(),
  ): Promise<StoredAvatarObject | undefined> {
    const { client, bucket } = this.require(objectKey);
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: objectKey }),
        { abortSignal: signal },
      );
      return {
        contentType: head.ContentType,
        byteSize: head.ContentLength,
        lastModified: head.LastModified,
      };
    } catch (error) {
      if (objectStorageNotFound(error)) return undefined;
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
        error,
        signal,
      );
    }
  }

  async deleteObject(
    objectKey: string,
    signal = objectStorageSignal(),
  ): Promise<void> {
    const { client, bucket } = this.require(objectKey);
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }),
        { abortSignal: signal },
      );
    } catch (error) {
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
        error,
        signal,
      );
    }
  }

  async deleteStagingObject(
    objectKey: string,
    signal = objectStorageSignal(),
  ): Promise<void> {
    const { client, stagingBucket } = this.requireStaging(objectKey);
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: stagingBucket, Key: objectKey }),
        { abortSignal: signal },
      );
    } catch (error) {
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
        error,
        signal,
      );
    }
  }

  async *listObjects(prefix: string): AsyncIterable<ListedAvatarObject> {
    if (this.configured === undefined) {
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
      );
    }
    const { client, bucket } = this.configured;

    let continuationToken: string | undefined;
    do {
      const signal = objectStorageSignal();
      let page: ListObjectsV2CommandOutput;
      try {
        page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ...(continuationToken === undefined
              ? {}
              : { ContinuationToken: continuationToken }),
          }),
          { abortSignal: signal },
        );
      } catch (error) {
        throw objectStorageUnavailable(
          'AVATAR_STORAGE_UNAVAILABLE',
          'Avatar storage is unavailable',
          error,
          signal,
        );
      }
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) {
          yield { objectKey: object.Key, lastModified: object.LastModified };
        }
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken !== undefined);
  }

  async *listStagingObjects(prefix: string): AsyncIterable<ListedAvatarObject> {
    if (this.configured === undefined)
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
      );
    const { client, stagingBucket } = this.configured;
    let continuationToken: string | undefined;
    do {
      const signal = objectStorageSignal();
      let page: ListObjectsV2CommandOutput;
      try {
        page = await client.send(
          new ListObjectsV2Command({
            Bucket: stagingBucket,
            Prefix: prefix,
            ...(continuationToken === undefined
              ? {}
              : { ContinuationToken: continuationToken }),
          }),
          { abortSignal: signal },
        );
      } catch (error) {
        throw objectStorageUnavailable(
          'AVATAR_STORAGE_UNAVAILABLE',
          'Avatar storage is unavailable',
          error,
          signal,
        );
      }
      for (const object of page.Contents ?? [])
        if (object.Key !== undefined)
          yield { objectKey: object.Key, lastModified: object.LastModified };
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken !== undefined);
  }

  private requireStaging(objectKey: string): Configured {
    const configured = this.require(objectKey);
    if (!configured.stagingBucket)
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
      );
    return configured;
  }

  private require(objectKey: string): Configured {
    if (this.configured === undefined) {
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
      );
    }
    if (!validObjectKey(objectKey)) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Avatar object key is invalid',
        retryable: false,
      });
    }
    return this.configured;
  }
}
