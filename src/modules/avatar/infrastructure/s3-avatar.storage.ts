import {
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
const DEFAULT_ORIGIN = new URL(DEFAULT_SEAWEEDFS_ENDPOINT).origin;

export interface AvatarStorageOptions {
  readonly bucket?: string | undefined;
  readonly now?: () => Date;
  /** Replaces the S3 client built from runtime secrets; for tests. */
  readonly client?: Pick<S3Client, 'send'>;
}

function storageUnavailable(cause?: unknown): AppError {
  return new AppError({
    code: 'AVATAR_STORAGE_UNAVAILABLE',
    message: 'Avatar storage is unavailable',
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

function validObjectKey(objectKey: string): boolean {
  return (
    objectKey.startsWith('users/') &&
    objectKey.length <= 1_024 &&
    !objectKey.includes('..') &&
    !/[\s?#]/.test(objectKey)
  );
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return name === 'NotFound' || $metadata?.httpStatusCode === 404;
}

interface Configured {
  readonly client: Pick<S3Client, 'send'>;
  /** Kept apart from `client`: a test client cannot presign. */
  readonly signer: S3Client | undefined;
  readonly bucket: string;
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

    if (sharedClient === undefined || bucket.length === 0) {
      this.configured = undefined;
      return;
    }

    this.configured = {
      client: options.client ?? sharedClient,
      signer: sharedClient,
      bucket,
      origin: DEFAULT_ORIGIN,
    };
  }

  async createUploadUrl(input: {
    readonly objectKey: string;
    readonly contentType: AvatarContentType;
    readonly byteSize: number;
  }): Promise<AvatarUploadUrl> {
    const { signer, bucket } = this.require(input.objectKey);
    if (signer === undefined) {
      throw storageUnavailable();
    }
    const expiresAt = new Date(
      this.now().getTime() + AVATAR_UPLOAD_URL_TTL_SECONDS * 1_000,
    );
    try {
      const url = await getSignedUrl(
        signer,
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.objectKey,
          ContentType: input.contentType,
          ContentLength: input.byteSize,
          CacheControl: AVATAR_CACHE_CONTROL,
        }),
        {
          expiresIn: AVATAR_UPLOAD_URL_TTL_SECONDS,
          // Bound into the signature so a client cannot sign one image and
          // send another. Storage may still not enforce it; completion
          // re-checks what landed.
          signableHeaders: new Set([
            'content-type',
            'content-length',
            'cache-control',
          ]),
        },
      );
      return { url, expiresAt };
    } catch (error) {
      throw storageUnavailable(error);
    }
  }

  publicUrl(objectKey: string): string {
    const { origin, bucket } = this.require(objectKey);
    const path = [bucket, ...objectKey.split('/')]
      .map(encodeURIComponent)
      .join('/');
    return `${origin}/${path}`;
  }

  async describeObject(
    objectKey: string,
  ): Promise<StoredAvatarObject | undefined> {
    const { client, bucket } = this.require(objectKey);
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: objectKey }),
      );
      return {
        contentType: head.ContentType,
        byteSize: head.ContentLength,
        lastModified: head.LastModified,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw storageUnavailable(error);
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    const { client, bucket } = this.require(objectKey);
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }),
      );
    } catch (error) {
      throw storageUnavailable(error);
    }
  }

  async *listObjects(prefix: string): AsyncIterable<ListedAvatarObject> {
    if (this.configured === undefined) {
      throw storageUnavailable();
    }
    const { client, bucket } = this.configured;

    let continuationToken: string | undefined;
    do {
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
        );
      } catch (error) {
        throw storageUnavailable(error);
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

  private require(objectKey: string): Configured {
    if (this.configured === undefined) {
      throw storageUnavailable();
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
