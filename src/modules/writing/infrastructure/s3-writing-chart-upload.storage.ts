import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

import {
  objectStorageNotFound,
  objectStorageSignal,
  objectStorageUnavailable,
} from '@/modules/secrets/public/object-storage';
import type { WritingChartRevocationStoragePort } from '@/modules/writing/application/writing-chart-revocation.port';
import { WRITING_CHART_MAX_BYTES } from '@/modules/writing/application/writing-chart-upload.policy';
import type { WritingChartUploadStoragePort } from '@/modules/writing/application/writing-chart-upload.port';
import {
  type WritingChartContentType,
  type WritingChartEnvironment,
} from '@/modules/writing/domain/writing-chart-upload';
import {
  WRITING_CHART_BUCKETS,
  WRITING_CHART_UPLOAD_URL_TTL_SECONDS,
} from './writing-chart-storage.policy';

type S3ClientPort = Pick<S3Client, 'send'>;

export interface S3WritingChartUploadStorageOptions {
  readonly environment: WritingChartEnvironment;
  readonly stagingBucket?: string;
  readonly publicBucket?: string;
  readonly publicBaseUrl?: string;
  readonly client?: S3ClientPort;
}

function validBaseUrl(value: string | undefined): URL | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.hostname.toLowerCase() !== 's3.wispace.app' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    )
      return undefined;
    return new URL(url.href.endsWith('/') ? url.href : `${url.href}/`);
  } catch {
    return undefined;
  }
}

function isChartKey(value: string, stage: 'staging' | 'published'): boolean {
  return (
    /^writing-charts\/chart_[0-9A-HJKMNP-TV-Z]{26}\/(staging|published)$/.test(
      value,
    ) && value.endsWith(`/${stage}`)
  );
}

export class S3WritingChartUploadStorage
  implements WritingChartUploadStoragePort, WritingChartRevocationStoragePort
{
  private readonly signer: S3Client | undefined;
  private readonly client: S3ClientPort | undefined;
  private readonly environment: WritingChartEnvironment;
  private readonly stagingBucket: string | undefined;
  private readonly publicBucket: string | undefined;
  private readonly publicBaseUrl: URL | undefined;

  constructor(
    sharedClient: S3Client | undefined,
    options: S3WritingChartUploadStorageOptions,
  ) {
    this.signer = sharedClient;
    this.client = options.client ?? sharedClient;
    this.environment = options.environment;
    const buckets = WRITING_CHART_BUCKETS[options.environment];
    this.stagingBucket =
      options.stagingBucket === buckets.staging
        ? options.stagingBucket
        : undefined;
    this.publicBucket =
      options.publicBucket === buckets.public
        ? options.publicBucket
        : undefined;
    this.publicBaseUrl = validBaseUrl(options.publicBaseUrl);
  }

  async createUploadUrl(input: {
    readonly environment: WritingChartEnvironment;
    readonly stagingKey: string;
    readonly contentType: WritingChartContentType;
    readonly byteSize: number;
  }): Promise<{
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  }> {
    const { signer, bucket } = this.require(
      input.environment,
      input.stagingKey,
      'staging',
      true,
    );
    if (this.publicBucket === undefined || this.publicBaseUrl === undefined) {
      throw objectStorageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        'Writing chart storage is unavailable',
      );
    }
    if (signer === undefined)
      throw objectStorageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        'Writing chart storage is unavailable',
      );
    const expiresAt = new Date(
      Date.now() + WRITING_CHART_UPLOAD_URL_TTL_SECONDS * 1_000,
    );
    try {
      const { url, fields } = await createPresignedPost(signer, {
        Bucket: bucket,
        Key: input.stagingKey,
        Expires: WRITING_CHART_UPLOAD_URL_TTL_SECONDS,
        Conditions: [['content-length-range', input.byteSize, input.byteSize]],
        Fields: { 'Content-Type': input.contentType },
      });
      return { url, fields, expiresAt };
    } catch (error) {
      throw objectStorageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        'Writing chart storage is unavailable',
        error,
      );
    }
  }

  async inspectObject(
    input: {
      readonly environment: WritingChartEnvironment;
      readonly stagingKey: string;
      readonly byteSize: number;
    },
    signal = objectStorageSignal(),
  ) {
    const { client, bucket } = this.require(
      input.environment,
      input.stagingKey,
      'staging',
    );
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: input.stagingKey }),
        { abortSignal: signal },
      );
      if (
        head.ContentLength === undefined ||
        head.ContentLength < 1 ||
        !head.ETag
      )
        return undefined;
      const size = head.ContentLength;
      if (size > WRITING_CHART_MAX_BYTES || size !== input.byteSize) {
        return {
          contentType: head.ContentType,
          byteSize: size,
          bytes: new Uint8Array(),
        };
      }
      const bytes = await this.readObject(
        client,
        bucket,
        input.stagingKey,
        size,
        head.ETag,
        signal,
      );
      return {
        contentType: head.ContentType,
        byteSize: size,
        bytes,
      };
    } catch (error) {
      if (objectStorageNotFound(error)) return undefined;
      throw objectStorageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        'Writing chart storage is unavailable',
        error,
        signal,
      );
    }
  }

  async publishObject(
    input: {
      readonly environment: WritingChartEnvironment;
      readonly stagingKey: string;
      readonly publishedKey: string;
      readonly contentType: WritingChartContentType;
      readonly bytes: Uint8Array;
    },
    signal = objectStorageSignal(),
  ): Promise<void> {
    this.require(input.environment, input.stagingKey, 'staging');
    const target = this.require(
      input.environment,
      input.publishedKey,
      'published',
    );
    try {
      await target.client.send(
        new PutObjectCommand({
          Bucket: target.bucket,
          Key: input.publishedKey,
          Body: input.bytes,
          ContentLength: input.bytes.byteLength,
          ContentType: input.contentType,
          ContentDisposition: 'inline',
          CacheControl: 'public, max-age=300, must-revalidate',
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      throw objectStorageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        'Writing chart storage is unavailable',
        error,
        signal,
      );
    }
  }

  publicUrl(input: {
    readonly environment: WritingChartEnvironment;
    readonly publishedKey: string;
  }): string {
    const { bucket, publicBaseUrl } = this.require(
      input.environment,
      input.publishedKey,
      'published',
      true,
    );
    if (publicBaseUrl === undefined)
      throw objectStorageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        'Writing chart storage is unavailable',
      );
    return new URL(`${bucket}/${input.publishedKey}`, publicBaseUrl).href;
  }

  async deleteStagingObject(
    input: {
      readonly environment: WritingChartEnvironment;
      readonly stagingKey: string;
    },
    signal = objectStorageSignal(),
  ): Promise<void> {
    const { client, bucket } = this.require(
      input.environment,
      input.stagingKey,
      'staging',
    );
    await this.delete(client, bucket, input.stagingKey, signal);
  }

  async deletePublishedObject(
    input: {
      readonly environment: WritingChartEnvironment;
      readonly publishedKey: string;
    },
    signal = objectStorageSignal(),
  ): Promise<void> {
    const { client, bucket } = this.require(
      input.environment,
      input.publishedKey,
      'published',
    );
    await this.delete(client, bucket, input.publishedKey, signal);
  }

  async deletePublishedObjectIfPresent(input: {
    readonly environment: WritingChartEnvironment;
    readonly publishedKey: string;
  }): Promise<'deleted' | 'already_absent'> {
    const { client, bucket } = this.require(
      input.environment,
      input.publishedKey,
      'published',
    );
    const signal = objectStorageSignal();
    try {
      await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: input.publishedKey }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (objectStorageNotFound(error)) return 'already_absent';
      throw objectStorageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        'Writing chart storage is unavailable',
        error,
        signal,
      );
    }
    return (await this.delete(client, bucket, input.publishedKey, signal))
      ? 'deleted'
      : 'already_absent';
  }

  private async delete(
    client: S3ClientPort,
    bucket: string,
    key: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: signal,
      });
      return true;
    } catch (error) {
      if (objectStorageNotFound(error)) return false;
      throw objectStorageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        'Writing chart storage is unavailable',
        error,
        signal,
      );
    }
  }

  private async readObject(
    client: S3ClientPort,
    bucket: string,
    key: string,
    size: number,
    etag: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=0-${size - 1}`,
        IfMatch: etag,
      }),
      { abortSignal: signal },
    );
    if (
      response.ContentRange !== `bytes 0-${size - 1}/${size}` ||
      response.ContentLength !== size ||
      response.ETag !== etag ||
      response.Body === undefined
    ) {
      throw objectStorageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        'Writing chart storage is unavailable',
      );
    }
    const bytes = await response.Body.transformToByteArray();
    if (
      bytes.byteLength !== size ||
      bytes.byteLength > WRITING_CHART_MAX_BYTES
    ) {
      throw objectStorageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        'Writing chart storage is unavailable',
      );
    }
    return bytes;
  }

  private require(
    environment: WritingChartEnvironment,
    key: string,
    target: 'staging' | 'published',
    requirePublicUrl = false,
  ): {
    readonly signer: S3Client | undefined;
    readonly client: S3ClientPort;
    readonly bucket: string;
    readonly publicBaseUrl: URL | undefined;
  } {
    const validKey = isChartKey(key, target);
    const client = this.client;
    const bucket =
      target === 'staging' ? this.stagingBucket : this.publicBucket;
    if (
      environment !== this.environment ||
      !validKey ||
      client === undefined ||
      (requirePublicUrl && this.publicBaseUrl === undefined) ||
      bucket === undefined
    )
      throw objectStorageUnavailable(
        'WRITING_CHART_STORAGE_UNAVAILABLE',
        'Writing chart storage is unavailable',
      );
    return {
      signer: this.signer,
      client,
      bucket,
      publicBaseUrl: this.publicBaseUrl,
    };
  }
}
