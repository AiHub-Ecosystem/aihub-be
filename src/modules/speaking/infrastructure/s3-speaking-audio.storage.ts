import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import type { RuntimeSecretProvider } from '@/modules/secrets/application/runtime-secret-provider.port';
import type { SpeakingAudioStoragePort } from '@/modules/speaking/application/speaking-audio-storage.port';
import { SPEAKING_AUDIO_URL_HOST } from '@/modules/speaking/application/speaking-audio-url.policy';

export const DEFAULT_SEAWEEDFS_ENDPOINT = `https://${SPEAKING_AUDIO_URL_HOST}`;
export const DEFAULT_SEAWEEDFS_BUCKET = 'aihub-speaking-samples';
export const DEFAULT_SEAWEEDFS_REGION = 'us-east-1';
export const SPEAKING_AUDIO_URL_TTL_SECONDS = 15 * 60;

interface StorageConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly expiresInSeconds: number;
}

export interface SpeakingAudioStorageOptions {
  readonly endpoint?: string;
  readonly bucket?: string;
  readonly region?: string;
  readonly expiresInSeconds?: number;
}

function storageError(message: string): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message,
    retryable: false,
  });
}

function configuredStorage(
  secretProvider: RuntimeSecretProvider,
  options: SpeakingAudioStorageOptions,
): StorageConfig | undefined {
  const credentials = secretProvider.getSnapshot().seaweedfs;
  if (credentials === undefined) {
    return undefined;
  }

  const endpoint = (
    options.endpoint ??
    process.env.SEAWEEDFS_ENDPOINT_URL ??
    DEFAULT_SEAWEEDFS_ENDPOINT
  ).trim();
  const bucket = (
    options.bucket ??
    process.env.SEAWEEDFS_BUCKET ??
    DEFAULT_SEAWEEDFS_BUCKET
  ).trim();
  const region = (
    options.region ??
    process.env.SEAWEEDFS_REGION ??
    DEFAULT_SEAWEEDFS_REGION
  ).trim();

  if (!bucket || !region) {
    throw storageError('Speaking sample audio storage is misconfigured');
  }

  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== SPEAKING_AUDIO_URL_HOST ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('invalid SeaweedFS endpoint');
    }
  } catch {
    throw storageError('Speaking sample audio storage is misconfigured');
  }

  return {
    endpoint,
    bucket,
    region,
    expiresInSeconds:
      options.expiresInSeconds ?? SPEAKING_AUDIO_URL_TTL_SECONDS,
  };
}

function validObjectKey(objectKey: string): boolean {
  return (
    objectKey.length > 0 &&
    objectKey.length <= 1_024 &&
    !objectKey.startsWith('/') &&
    !objectKey.includes('..') &&
    !/[\s?#]/.test(objectKey)
  );
}

@Injectable()
export class S3SpeakingAudioStorage implements SpeakingAudioStoragePort {
  private readonly client: S3Client | undefined;
  private readonly config: StorageConfig | undefined;

  constructor(
    secretProvider: RuntimeSecretProvider,
    options: SpeakingAudioStorageOptions = {},
  ) {
    this.config = configuredStorage(secretProvider, options);
    if (this.config === undefined) {
      this.client = undefined;
      return;
    }

    const credentials = secretProvider.getSnapshot().seaweedfs;
    if (credentials === undefined) {
      this.client = undefined;
      return;
    }

    this.client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
  }

  async getReadUrl(objectKey: string): Promise<string> {
    if (this.client === undefined || this.config === undefined) {
      throw storageError('Speaking sample audio storage is not configured');
    }
    if (!validObjectKey(objectKey)) {
      throw storageError('Speaking sample audio object key is invalid');
    }

    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey,
        }),
        { expiresIn: this.config.expiresInSeconds },
      );
    } catch {
      throw storageError('Speaking sample audio storage is unavailable');
    }
  }
}
