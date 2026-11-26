import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Logger } from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import type {
  AvatarStoragePort,
  AvatarUploadUrl,
  ListedAvatarObject,
  StagedAvatarObject,
  StoredAvatarObject,
} from '@/modules/avatar/application/avatar-storage.port';
import {
  AVATAR_CACHE_CONTROL,
  AVATAR_MAX_BYTES,
  AVATAR_UPLOAD_URL_TTL_SECONDS,
  type AvatarContentType,
} from '@/modules/avatar/domain/avatar';
import {
  DEFAULT_SEAWEEDFS_ENDPOINT,
  objectStorageNotFound,
  objectStorageSignal,
  objectStorageUnavailable,
} from '@/modules/secrets/public/object-storage';
import {
  AVATAR_BUCKETS,
  AVATAR_STAGING_BUCKETS,
  type AvatarStorageEnvironment,
  avatarBucketFor,
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
    const environment = options.environment ?? 'production';
    const bucket = avatarBucketFor(environment, options.bucket);
    const defaultStagingBucket = AVATAR_STAGING_BUCKETS[environment];
    const stagingBucket = options.stagingBucket?.trim() || defaultStagingBucket;

    if (
      sharedClient !== undefined &&
      bucket === undefined &&
      (options.bucket ?? '').trim().length > 0
    ) {
      // A bucket this scope does not own is the misconfiguration whose sweep
      // would delete another deployment's Avatars (#428). Name it once at
      // startup; the bucket name is not a secret.
      new Logger('S3AvatarStorage').warn({
        event: 'avatar_storage_bucket_not_owned',
        environment,
        configuredBucket: options.bucket?.trim(),
        expectedBucket: AVATAR_BUCKETS[environment],
      });
    }

    if (
      sharedClient === undefined ||
      bucket === undefined ||
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

  async readStagingObject(
    objectKey: string,
    etag: string | undefined,
    signal = objectStorageSignal(),
  ): Promise<StagedAvatarObject | undefined> {
    const { client, stagingBucket } = this.requireStaging(objectKey);
    try {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: stagingBucket,
          Key: objectKey,
          ...(etag === undefined ? {} : { IfMatch: etag }),
        }),
        { abortSignal: signal },
      );
      if (response.Body === undefined) {
        throw objectStorageUnavailable(
          'AVATAR_STORAGE_UNAVAILABLE',
          'Avatar storage is unavailable',
        );
      }
      const bytes = await response.Body.transformToByteArray();
      // A response larger than the ceiling cannot be an Avatar; refusing it
      // keeps a lying HeadObject from turning into an unbounded read.
      if (bytes.byteLength < 1 || bytes.byteLength > AVATAR_MAX_BYTES) {
        throw objectStorageUnavailable(
          'AVATAR_STORAGE_UNAVAILABLE',
          'Avatar storage is unavailable',
        );
      }
      return { contentType: response.ContentType, bytes };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (objectStorageNotFound(error)) return undefined;
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
        error,
        signal,
      );
    }
  }

  async putFinalObject(input: {
    readonly objectKey: string;
    readonly contentType: AvatarContentType;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const { client, bucket } = this.require(input.objectKey);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.objectKey,
          Body: input.bytes,
          ContentLength: input.bytes.byteLength,
          ContentType: input.contentType,
          ContentDisposition: 'inline',
          CacheControl: AVATAR_CACHE_CONTROL,
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

  async *listObjects(
    prefix: string,
    startAfter?: string,
  ): AsyncIterable<ListedAvatarObject> {
    if (this.configured === undefined) {
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
      );
    }
    const { client, bucket } = this.configured;
    yield* this.listBucket(client, bucket, prefix, startAfter);
  }

  async *listStagingObjects(
    prefix: string,
    startAfter?: string,
  ): AsyncIterable<ListedAvatarObject> {
    if (this.configured === undefined)
      throw objectStorageUnavailable(
        'AVATAR_STORAGE_UNAVAILABLE',
        'Avatar storage is unavailable',
      );
    const { client, stagingBucket } = this.configured;
    yield* this.listBucket(client, stagingBucket, prefix, startAfter);
  }

  /** One pagination loop for both Avatar buckets, including recovery cursors. */
  private async *listBucket(
    client: Pick<S3Client, 'send'>,
    bucket: string,
    prefix: string,
    startAfter?: string,
  ): AsyncIterable<ListedAvatarObject> {
    let continuationToken: string | undefined;
    do {
      const signal = objectStorageSignal();
      let page: ListObjectsV2CommandOutput;
      try {
        page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ...(startAfter === undefined ? {} : { StartAfter: startAfter }),
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
