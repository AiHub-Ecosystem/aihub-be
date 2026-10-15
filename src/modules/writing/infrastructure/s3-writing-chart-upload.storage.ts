import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { AppError } from '@/common/errors/app-error';
import {
  WRITING_CHART_BUCKETS,
  WRITING_CHART_MAX_BYTES,
  WRITING_CHART_RANGE_BYTES,
  WRITING_CHART_UPLOAD_URL_TTL_SECONDS,
  type WritingChartContentType,
  type WritingChartEnvironment,
} from '@/modules/writing/domain/writing-chart-upload';
import type { WritingChartUploadStoragePort } from '../application/writing-chart-upload.port';

type S3ClientPort = Pick<S3Client, 'send'>;

export interface S3WritingChartUploadStorageOptions {
  readonly environment: WritingChartEnvironment;
  readonly stagingBucket?: string;
  readonly publicBucket?: string;
  readonly publicBaseUrl?: string;
  readonly now?: () => Date;
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
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return name === 'NotFound' || $metadata?.httpStatusCode === 404;
}

function validBaseUrl(value: string | undefined): URL | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      ['aihubproduction.com', 'wispace.app'].some(
        (domain) =>
          url.hostname.toLowerCase() === domain ||
          url.hostname.toLowerCase().endsWith(`.${domain}`),
      )
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
  private readonly now: () => Date;

  constructor(
    sharedClient: S3Client | undefined,
    options: S3WritingChartUploadStorageOptions,
  ) {
    this.signer = sharedClient;
    this.client = options.client ?? sharedClient;
    this.environment = options.environment;
    this.now = options.now ?? (() => new Date());
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
  }): Promise<{ readonly url: string; readonly expiresAt: Date }> {
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
      this.now().getTime() + WRITING_CHART_UPLOAD_URL_TTL_SECONDS * 1_000,
    );
    try {
      const url = await getSignedUrl(
        signer,
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.stagingKey,
          ContentType: input.contentType,
        }),
        {
          expiresIn: WRITING_CHART_UPLOAD_URL_TTL_SECONDS,
          // Browser Fetch controls Content-Length; completion verifies the stored size.
          signableHeaders: new Set(['content-type']),
        },
      );
      return { url, expiresAt };
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
      const head = (await client!.send(
        new HeadObjectCommand({ Bucket: bucket, Key: input.stagingKey }),
      )) as { ContentType?: string; ContentLength?: number; ETag?: string };
      if (
        head.ContentLength === undefined ||
        head.ContentLength < 1 ||
        !head.ETag
      )
        return undefined;
      const size = head.ContentLength;
      if (size > WRITING_CHART_MAX_BYTES) {
        return {
          contentType: head.ContentType,
          byteSize: size,
          etag: head.ETag,
          prefix: new Uint8Array(),
          suffix: new Uint8Array(),
        };
      }
      const firstEnd = Math.min(size, WRITING_CHART_RANGE_BYTES) - 1;
      const suffixStart = Math.max(0, size - WRITING_CHART_RANGE_BYTES);
      const [prefix, suffix] = await Promise.all([
        this.readRange(client!, bucket, input.stagingKey, 0, firstEnd, size),
        this.readRange(
          client!,
          bucket,
          input.stagingKey,
          suffixStart,
          size - 1,
          size,
        ),
      ]);
      return {
        contentType: head.ContentType,
        byteSize: head.ContentLength,
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
      await source.client!.send(
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
    const { publicBaseUrl } = this.require(
      input.environment,
      input.publishedKey,
      'published',
      true,
    );
    if (publicBaseUrl === undefined) throw storageUnavailable();
    return new URL(input.publishedKey, publicBaseUrl).href;
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
    await this.delete(client!, bucket, input.stagingKey);
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
    await this.delete(client!, bucket, input.publishedKey);
  }

  private async readRange(
    client: S3ClientPort,
    bucket: string,
    key: string,
    start: number,
    end: number,
    size: number,
  ): Promise<Uint8Array> {
    if (end < start) return new Uint8Array();
    const response = (await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=${start}-${end}`,
      }),
    )) as {
      ContentRange?: string;
      ContentLength?: number;
      Body?: { transformToByteArray?: () => Promise<Uint8Array> };
    };
    const expected = `bytes ${start}-${end}/${size}`;
    if (
      response.ContentRange !== expected ||
      response.ContentLength !== end - start + 1 ||
      response.Body?.transformToByteArray === undefined
    )
      throw storageUnavailable();
    const bytes = await response.Body.transformToByteArray();
    if (
      bytes.byteLength !== end - start + 1 ||
      bytes.byteLength > WRITING_CHART_RANGE_BYTES
    ) {
      throw storageUnavailable();
    }
    return bytes;
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

  private require(
    environment: WritingChartEnvironment,
    key: string,
    target: 'staging' | 'published',
    requirePublicUrl = false,
  ): {
    readonly signer: S3Client | undefined;
    readonly client: S3ClientPort | undefined;
    readonly bucket: string;
    readonly publicBaseUrl: URL | undefined;
  } {
    const validKey = isChartKey(key, target);
    const bucket =
      target === 'staging' ? this.stagingBucket : this.publicBucket;
    if (
      environment !== this.environment ||
      !validKey ||
      this.client === undefined ||
      (requirePublicUrl && this.publicBaseUrl === undefined) ||
      bucket === undefined
    )
      throw storageUnavailable();
    return {
      signer: this.signer,
      client: this.client,
      bucket,
      publicBaseUrl: this.publicBaseUrl,
    };
  }
}
