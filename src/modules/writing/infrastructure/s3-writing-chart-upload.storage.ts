import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

import { AppError } from '@/common/errors/app-error';
import {
  WRITING_CHART_MAX_BYTES,
  WRITING_CHART_RANGE_BYTES,
} from '@/modules/writing/application/writing-chart-upload.policy';
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

function storageUnavailable(cause?: unknown): AppError {
  return new AppError({
    code: 'WRITING_CHART_STORAGE_UNAVAILABLE',
    message: 'Writing chart storage is unavailable',
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (!('name' in error) || !('$metadata' in error)) return false;
  const metadata = error.$metadata;
  return (
    error.name === 'NotFound' ||
    (typeof metadata === 'object' &&
      metadata !== null &&
      'httpStatusCode' in metadata &&
      metadata.httpStatusCode === 404)
  );
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
  implements WritingChartUploadStoragePort
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
      throw storageUnavailable();
    }
    if (signer === undefined) throw storageUnavailable();
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
      throw storageUnavailable(error);
    }
  }

  async inspectObject(input: {
    readonly environment: WritingChartEnvironment;
    readonly stagingKey: string;
    readonly byteSize: number;
  }) {
    const { client, bucket } = this.require(
      input.environment,
      input.stagingKey,
      'staging',
    );
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: input.stagingKey }),
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
          etag: head.ETag,
          prefix: new Uint8Array(),
          suffix: new Uint8Array(),
        };
      }
      const prefixEnd = Math.min(size, WRITING_CHART_RANGE_BYTES) - 1;
      const suffixStart = Math.max(0, size - WRITING_CHART_RANGE_BYTES);
      const [prefix, suffix] = await Promise.all([
        this.readRange(
          client,
          bucket,
          input.stagingKey,
          0,
          prefixEnd,
          size,
          head.ETag,
        ),
        this.readRange(
          client,
          bucket,
          input.stagingKey,
          suffixStart,
          size - 1,
          size,
          head.ETag,
        ),
      ]);
      return {
        contentType: head.ContentType,
        byteSize: size,
        etag: head.ETag,
        prefix,
        suffix,
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw storageUnavailable(error);
    }
  }

  async publishObject(input: {
    readonly environment: WritingChartEnvironment;
    readonly stagingKey: string;
    readonly publishedKey: string;
    readonly contentType: WritingChartContentType;
    readonly etag: string;
  }): Promise<void> {
    const source = this.require(input.environment, input.stagingKey, 'staging');
    const target = this.require(
      input.environment,
      input.publishedKey,
      'published',
    );
    try {
      await source.client.send(
        new CopyObjectCommand({
          Bucket: target.bucket,
          Key: input.publishedKey,
          CopySource: `${encodeURIComponent(source.bucket)}/${input.stagingKey
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`,
          CopySourceIfMatch: input.etag,
          ContentType: input.contentType,
          ContentDisposition: 'inline',
          CacheControl: 'public, max-age=300, must-revalidate',
          MetadataDirective: 'REPLACE',
        }),
      );
    } catch (error) {
      throw storageUnavailable(error);
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
    if (publicBaseUrl === undefined) throw storageUnavailable();
    return new URL(`${bucket}/${input.publishedKey}`, publicBaseUrl).href;
  }

  async deleteStagingObject(input: {
    readonly environment: WritingChartEnvironment;
    readonly stagingKey: string;
  }): Promise<void> {
    const { client, bucket } = this.require(
      input.environment,
      input.stagingKey,
      'staging',
    );
    await this.delete(client, bucket, input.stagingKey);
  }

  async deletePublishedObject(input: {
    readonly environment: WritingChartEnvironment;
    readonly publishedKey: string;
  }): Promise<void> {
    const { client, bucket } = this.require(
      input.environment,
      input.publishedKey,
      'published',
    );
    await this.delete(client, bucket, input.publishedKey);
  }

  private async delete(
    client: S3ClientPort,
    bucket: string,
    key: string,
  ): Promise<void> {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      if (!isNotFound(error)) throw storageUnavailable(error);
    }
  }

  private async readRange(
    client: S3ClientPort,
    bucket: string,
    key: string,
    start: number,
    end: number,
    size: number,
    etag: string,
  ): Promise<Uint8Array> {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=${start}-${end}`,
        IfMatch: etag,
      }),
    );
    const expectedSize = end - start + 1;
    if (
      response.ContentRange !== `bytes ${start}-${end}/${size}` ||
      response.ContentLength !== expectedSize ||
      response.ETag !== etag ||
      response.Body === undefined
    ) {
      throw storageUnavailable();
    }
    const bytes = await response.Body.transformToByteArray();
    if (
      bytes.byteLength !== expectedSize ||
      bytes.byteLength > WRITING_CHART_RANGE_BYTES
    ) {
      throw storageUnavailable();
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
      throw storageUnavailable();
    return {
      signer: this.signer,
      client,
      bucket,
      publicBaseUrl: this.publicBaseUrl,
    };
  }
}
