import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import type { SpeakingAudioStoragePort } from '@/modules/speaking/application/speaking-audio-storage.port';

export const SPEAKING_AUDIO_URL_TTL_SECONDS = 15 * 60;

interface StorageConfig {
  readonly bucket: string;
  readonly expiresInSeconds: number;
}

export interface SpeakingAudioStorageOptions {
  readonly bucket?: string;
  readonly expiresInSeconds?: number;
}

function storageError(message: string): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message,
    retryable: false,
  });
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
    client: S3Client | undefined,
    options: SpeakingAudioStorageOptions = {},
  ) {
    const bucket = options.bucket?.trim();
    this.client = client;
    this.config =
      client === undefined || bucket === undefined || bucket.length === 0
        ? undefined
        : {
            bucket,
            expiresInSeconds:
              options.expiresInSeconds ?? SPEAKING_AUDIO_URL_TTL_SECONDS,
          };
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
