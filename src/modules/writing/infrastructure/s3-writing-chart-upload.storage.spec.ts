import type { S3Client } from '@aws-sdk/client-s3';

import { createSeaweedFsS3Client } from '@/modules/secrets/infrastructure/seaweedfs-s3-client.factory';
import { S3WritingChartUploadStorage } from './s3-writing-chart-upload.storage';

const STAGING_KEY = 'writing-charts/chart_01J00000000000000000000001/staging';
const PUBLISHED_KEY =
  'writing-charts/chart_01J00000000000000000000001/published';

function createStorage(send = jest.fn().mockResolvedValue({}), overrides = {}) {
  return new S3WritingChartUploadStorage(
    createSeaweedFsS3Client({
      credentials: { accessKeyId: 'access', secretAccessKey: 'secret' },
    }),
    {
      environment: 'sandbox',
      stagingBucket: 'aihub-sandbox-writing-chart-staging',
      publicBucket: 'aihub-sandbox-writing-charts',
      publicBaseUrl: 'https://charts.example.net',
      client: { send } as unknown as Pick<S3Client, 'send'>,
      now: () => new Date('2026-10-14T00:00:00.000Z'),
      ...overrides,
    },
  );
}

describe('S3WritingChartUploadStorage contract', () => {
  it('signs a five-minute PUT against private staging with the declared type and size', async () => {
    const adapter = createStorage();
    const grant = await adapter.createUploadUrl({
      environment: 'sandbox',
      stagingKey: STAGING_KEY,
      contentType: 'image/png',
      byteSize: 1_024,
    });
    const url = new URL(grant.url);
    expect(url.hostname).toBe('s3.wispace.app');
    expect(url.pathname).toContain('/aihub-sandbox-writing-chart-staging/');
    expect(url.pathname).toContain(STAGING_KEY);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain(
      'content-type',
    );
    expect(url.searchParams.get('X-Amz-SignedHeaders')).not.toContain(
      'content-length',
    );
    expect(grant.expiresAt).toEqual(new Date('2026-10-14T00:05:00.000Z'));
  });

  it('reads only bounded ranges from the private bucket before publication', async () => {
    const image = Buffer.alloc(160_000, 0x61);
    const send = jest.fn().mockImplementation(async (raw: unknown) => {
      const command = raw as {
        readonly constructor: { readonly name: string };
        readonly input: { readonly Range?: string; readonly Bucket?: string };
      };
      if (command.constructor.name === 'HeadObjectCommand') {
        return {
          ContentType: 'image/png',
          ContentLength: image.length,
          ETag: '"verified-etag"',
        };
      }
      const range = command.input.Range ?? '';
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (command.constructor.name !== 'GetObjectCommand' || match === null) {
        throw new Error('unexpected storage command');
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      const bytes = image.subarray(start, end + 1);
      return {
        ContentRange: `bytes ${start}-${end}/${image.length}`,
        ContentLength: bytes.length,
        Body: { transformToByteArray: async () => bytes },
      };
    });
    const adapter = createStorage(send);

    const object = await adapter.inspectObject({
      environment: 'sandbox',
      stagingKey: STAGING_KEY,
      byteSize: image.length,
    });

    expect(object).toMatchObject({
      contentType: 'image/png',
      byteSize: image.length,
      etag: '"verified-etag"',
    });
    const ranges = send.mock.calls
      .filter(
        ([command]) =>
          (command as { constructor: { name: string } }).constructor.name ===
          'GetObjectCommand',
      )
      .map(
        ([command]) =>
          (command as { input: { Range: string; Bucket: string } }).input,
      );
    expect(ranges).toEqual([
      {
        Bucket: 'aihub-sandbox-writing-chart-staging',
        Key: STAGING_KEY,
        Range: 'bytes=0-65535',
      },
      {
        Bucket: 'aihub-sandbox-writing-chart-staging',
        Key: STAGING_KEY,
        Range: 'bytes=94464-159999',
      },
    ]);
    expect(ranges.every((range) => range.Range.length > 0)).toBe(true);
  });

  it('publishes to a different environment-isolated bucket and returns an unsigned chart URL', async () => {
    const send = jest.fn().mockResolvedValue({});
    const adapter = createStorage(send);

    await adapter.publishObject({
      environment: 'sandbox',
      stagingKey: STAGING_KEY,
      publishedKey: PUBLISHED_KEY,
      contentType: 'image/webp',
      etag: '"verified-etag"',
    });

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Bucket: 'aihub-sandbox-writing-charts',
        Key: PUBLISHED_KEY,
        CopySourceIfMatch: '"verified-etag"',
        ContentType: 'image/webp',
        ContentDisposition: 'inline',
        MetadataDirective: 'REPLACE',
      },
    });
    const url = adapter.publicUrl({
      environment: 'sandbox',
      publishedKey: PUBLISHED_KEY,
    });
    expect(url).toBe(`https://charts.example.net/${PUBLISHED_KEY}`);
    expect(url).not.toContain('?');
    expect(() =>
      adapter.publicUrl({
        environment: 'production',
        publishedKey: PUBLISHED_KEY,
      }),
    ).toThrow('Writing chart storage is unavailable');
  });

  it('rejects shared media buckets and a public origin on the API or S3 registrable domain', async () => {
    for (const options of [
      { publicBucket: 'aihub-user-assets' },
      { publicBaseUrl: undefined },
      { publicBaseUrl: 'https://charts.aihubproduction.com' },
      { publicBaseUrl: 'https://media.wispace.app' },
    ]) {
      const adapter = createStorage(jest.fn().mockResolvedValue({}), options);
      await expect(
        adapter.createUploadUrl({
          environment: 'sandbox',
          stagingKey: STAGING_KEY,
          contentType: 'image/png',
          byteSize: 100,
        }),
      ).rejects.toMatchObject({ code: 'WRITING_CHART_STORAGE_UNAVAILABLE' });
    }
  });
});
