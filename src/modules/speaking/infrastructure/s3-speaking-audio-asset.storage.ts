import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  objectStorageNotFound,
  objectStorageSignal,
  objectStorageUnavailable,
} from '@/modules/secrets/public/object-storage';
import type { SpeakingAudioAssetStoragePort } from '@/modules/speaking/application/audio/speaking-audio-upload.port';
import {
  SPEAKING_AUDIO_BUCKETS,
  SPEAKING_AUDIO_UPLOAD_URL_TTL_SECONDS,
  type SpeakingAudioEnvironment,
  isSpeakingAudioObjectKey,
  isSpeakingAudioStagingObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';

export interface SpeakingAudioAssetStorageOptions {
  readonly productionBucket?: string;
  readonly sandboxBucket?: string;
  readonly now?: () => Date;
  readonly client?: Pick<S3Client, 'send'>;
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
    sharedClient: S3Client | undefined,
    options: SpeakingAudioAssetStorageOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const productionBucket = (options.productionBucket ?? '').trim();
    const sandboxBucket = (options.sandboxBucket ?? '').trim();

    if (sharedClient === undefined) {
      this.configured = undefined;
      return;
    }

    this.configured = {
      signer: sharedClient,
      client: options.client ?? sharedClient,
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

  /**
   * Destroys the shared S3Client, releasing its keep-alive agents. CLI sweep
   * commands call this on completion so a cron-driven process drains instead
   * of holding sockets open (#1523). Unconfigured storage has no client. The
   * SDK destroy is synchronous.
   */
  async close(): Promise<void> {
    this.configured?.signer.destroy();
  }

  async createUploadUrl(input: {
    readonly environment: SpeakingAudioEnvironment;
    readonly objectKey: string;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<{ readonly url: string; readonly expiresAt: Date }> {
    const { signer, bucket } = this.require(input.environment, input.objectKey);
    if (!isSpeakingAudioStagingObjectKey(input.objectKey)) {
      throw objectStorageUnavailable(
        'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
        'Speaking audio storage is unavailable',
      );
    }
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
      throw objectStorageUnavailable(
        'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
        'Speaking audio storage is unavailable',
        error,
      );
    }
  }

  async copyObject(
    input: {
      readonly environment: SpeakingAudioEnvironment;
      readonly sourceObjectKey: string;
      readonly destinationObjectKey: string;
    },
    signal = objectStorageSignal(),
  ): Promise<void> {
    const { client, bucket } = this.require(
      input.environment,
      input.destinationObjectKey,
    );
    if (
      !isSpeakingAudioStagingObjectKey(input.sourceObjectKey) ||
      !isSpeakingAudioObjectKey(input.destinationObjectKey)
    ) {
      throw objectStorageUnavailable(
        'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
        'Speaking audio storage is unavailable',
      );
    }
    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${input.sourceObjectKey}`,
          Key: input.destinationObjectKey,
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      throw objectStorageUnavailable(
        'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
        'Speaking audio storage is unavailable',
        error,
        signal,
      );
    }
  }

  async describeObject(
    input: {
      readonly environment: SpeakingAudioEnvironment;
      readonly objectKey: string;
    },
    signal = objectStorageSignal(),
  ): Promise<
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
        { abortSignal: signal },
      );
      return {
        contentType: head.ContentType,
        byteSize: head.ContentLength,
      };
    } catch (error) {
      if (objectStorageNotFound(error)) {
        return undefined;
      }
      throw objectStorageUnavailable(
        'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
        'Speaking audio storage is unavailable',
        error,
        signal,
      );
    }
  }

  async deleteObject(
    input: {
      readonly environment: SpeakingAudioEnvironment;
      readonly objectKey: string;
    },
    signal = objectStorageSignal(),
  ): Promise<void> {
    const { client, bucket } = this.require(input.environment, input.objectKey);
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: input.objectKey }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (objectStorageNotFound(error)) {
        return;
      }
      throw objectStorageUnavailable(
        'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
        'Speaking audio storage is unavailable',
        error,
        signal,
      );
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
      throw objectStorageUnavailable(
        'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
        'Speaking audio storage is unavailable',
      );
    }
    if (
      !isSpeakingAudioObjectKey(objectKey) &&
      !isSpeakingAudioStagingObjectKey(objectKey)
    ) {
      throw objectStorageUnavailable(
        'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
        'Speaking audio storage is unavailable',
      );
    }

    const bucket =
      environment === 'production'
        ? this.configured.productionBucket
        : this.configured.sandboxBucket;
    if (bucket === undefined) {
      throw objectStorageUnavailable(
        'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
        'Speaking audio storage is unavailable',
      );
    }
    return {
      signer: this.configured.signer,
      client: this.configured.client,
      bucket,
    };
  }
}
