import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { AppError } from '@/common/errors/app-error';
import type { RuntimeSecretProvider } from '@/modules/secrets/application/runtime-secret-provider.port';
import type { SpeakingAudioAssetStoragePort } from '@/modules/speaking/application/speaking-audio-upload.port';
import {
  SPEAKING_AUDIO_BUCKETS,
  SPEAKING_AUDIO_UPLOAD_URL_TTL_SECONDS,
  isSpeakingAudioObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';
import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';

const SEAWEEDFS_HOST = 's3.wispace.app';
const DEFAULT_ENDPOINT = `https://${SEAWEEDFS_HOST}`;
const DEFAULT_REGION = 'us-east-1';
export interface SpeakingAudioAssetStorageOptions {
  readonly endpoint?: string;
  readonly region?: string;
  readonly productionBucket?: string;
  readonly sandboxBucket?: string;
  readonly now?: () => Date;
  readonly client?: Pick<S3Client, 'send'>;
}

function storageUnavailable(cause?: unknown): AppError {
  return new AppError({
    code: 'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
    message: 'Speaking audio storage is unavailable',
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
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

interface ConfiguredStorage {
  readonly signer: S3Client;
  readonly client: Pick<S3Client, 'send'>;
  readonly productionBucket: string | undefined;
  readonly sandboxBucket: string | undefined;
}

export class S3SpeakingAudioAssetStorage
  implements SpeakingAudioAssetStoragePort
{
  private readonly configured: ConfiguredStorage | undefined;
  private readonly now: () => Date;

  constructor(
    secretProvider: RuntimeSecretProvider,
    options: SpeakingAudioAssetStorageOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const credentials = secretProvider.getSnapshot().seaweedfs;
    const productionBucket = (
      options.productionBucket ??
      process.env.SEAWEEDFS_AUDIO_ASSET_BUCKET ??
      ''
    ).trim();
    const sandboxBucket = (
      options.sandboxBucket ??
      process.env.SEAWEEDFS_SANDBOX_AUDIO_ASSET_BUCKET ??
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
      signer,
      client: options.client ?? signer,
      productionBucket:
        productionBucket === SPEAKING_AUDIO_BUCKETS.production
          ? productionBucket
          : undefined,
      sandboxBucket:
        sandboxBucket === SPEAKING_AUDIO_BUCKETS.sandbox
          ? sandboxBucket
          : undefined,
    };
  }

  async createUploadUrl(input: {
    readonly environment: SpeakingAudioEnvironment;
    readonly objectKey: string;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<{ readonly url: string; readonly expiresAt: Date }> {
    const { signer, bucket } = this.require(input.environment, input.objectKey);
    const expiresAt = new Date(
      this.now().getTime() + SPEAKING_AUDIO_UPLOAD_URL_TTL_SECONDS * 1_000,
    );
    try {
      const url = await getSignedUrl(
        signer,
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.objectKey,
          ContentType: input.contentType,
          ContentLength: input.byteSize,
        }),
        {
          expiresIn: SPEAKING_AUDIO_UPLOAD_URL_TTL_SECONDS,
          signableHeaders: new Set(['content-type', 'content-length']),
        },
      );
      return { url, expiresAt };
    } catch (error) {
      throw storageUnavailable(error);
    }
  }

  async describeObject(input: {
    readonly environment: SpeakingAudioEnvironment;
    readonly objectKey: string;
  }): Promise<
    | {
        readonly contentType: string | undefined;
        readonly byteSize: number | undefined;
      }
    | undefined
  > {
    const { client, bucket } = this.require(input.environment, input.objectKey);
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: input.objectKey }),
      );
      return {
        contentType: head.ContentType,
        byteSize: head.ContentLength,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw storageUnavailable(error);
    }
  }

  async deleteObject(input: {
    readonly environment: SpeakingAudioEnvironment;
    readonly objectKey: string;
  }): Promise<void> {
    const { client, bucket } = this.require(input.environment, input.objectKey);
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: input.objectKey }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw storageUnavailable(error);
    }
  }

  private require(
    environment: SpeakingAudioEnvironment,
    objectKey: string,
  ): {
    readonly signer: S3Client;
    readonly client: Pick<S3Client, 'send'>;
    readonly bucket: string;
  } {
    if (this.configured === undefined) {
      throw storageUnavailable();
    }
    if (!isSpeakingAudioObjectKey(objectKey)) {
      throw storageUnavailable();
    }

    const bucket =
      environment === 'production'
        ? this.configured.productionBucket
        : this.configured.sandboxBucket;
    if (bucket === undefined) {
      throw storageUnavailable();
    }
    return {
      signer: this.configured.signer,
      client: this.configured.client,
      bucket,
    };
  }
}
