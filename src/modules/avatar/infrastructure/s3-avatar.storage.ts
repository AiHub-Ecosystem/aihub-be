import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { AppError } from '@/common/errors/app-error';
import type {
  AvatarStoragePort,
  AvatarUploadUrl,
  StoredAvatarObject,
} from '@/modules/avatar/application/avatar-storage.port';
import {
  AVATAR_CACHE_CONTROL,
  AVATAR_UPLOAD_URL_TTL_SECONDS,
  type AvatarContentType,
} from '@/modules/avatar/domain/avatar';
import type { RuntimeSecretProvider } from '@/modules/secrets/application/runtime-secret-provider.port';

// ponytail: builds its own S3 client beside the Speaking sample adapter rather
// than sharing one; module infrastructure is never imported across modules.
// Extract a shared client into `secrets` once the Audio asset (ADR-0065) adds
// a third user of it.
const SEAWEEDFS_HOST = 's3.wispace.app';
const DEFAULT_ENDPOINT = `https://${SEAWEEDFS_HOST}`;
const DEFAULT_REGION = 'us-east-1';

export interface AvatarStorageOptions {
  readonly endpoint?: string;
  readonly bucket?: string;
  readonly region?: string;
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

function approvedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === 'https:' &&
      url.hostname === SEAWEEDFS_HOST &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
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
    secretProvider: RuntimeSecretProvider,
    options: AvatarStorageOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const credentials = secretProvider.getSnapshot().seaweedfs;
    const bucket = (
      options.bucket ??
      process.env.SEAWEEDFS_USER_ASSET_BUCKET ??
      ''
    ).trim();
    const endpoint = (
      options.endpoint ??
      process.env.SEAWEEDFS_ENDPOINT_URL ??
      DEFAULT_ENDPOINT
    ).trim();
    const region = (
      options.region ??
      process.env.SEAWEEDFS_REGION ??
      DEFAULT_REGION
    ).trim();

    if (
      credentials === undefined ||
      bucket.length === 0 ||
      region.length === 0 ||
      !approvedEndpoint(endpoint)
    ) {
      this.configured = undefined;
      return;
    }

    const signer = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
    this.configured = {
      client: options.client ?? signer,
      signer,
      bucket,
      origin: new URL(endpoint).origin,
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
      return { contentType: head.ContentType, byteSize: head.ContentLength };
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
