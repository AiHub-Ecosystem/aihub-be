import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import { createSeaweedFsS3Client } from '@/modules/secrets/infrastructure/seaweedfs-s3-client.factory';
import { WRITING_CHART_MAX_BYTES } from '@/modules/writing/application/writing-chart-upload.policy';
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
      publicBaseUrl: 'https://s3.wispace.app',
      client: { send } as unknown as Pick<S3Client, 'send'>,
      ...overrides,
    },
  );
}

describe('S3WritingChartUploadStorage contract', () => {
  it('signs a five-minute POST policy for the exact declared size and type', async () => {
    const adapter = createStorage();
    const grant = await adapter.createUploadUrl({
      environment: 'sandbox',
      stagingKey: STAGING_KEY,
      contentType: 'image/png',
      byteSize: 1_024,
    });
    const url = new URL(grant.url);
    expect(url.hostname).toBe('s3.wispace.app');
    expect(url.pathname).toContain('/aihub-sandbox-writing-chart-staging');
    const encodedPolicy = grant.fields.Policy;
    expect(encodedPolicy).toBeDefined();
    const policy = JSON.parse(
      Buffer.from(encodedPolicy ?? '', 'base64').toString('utf8'),
    ) as { conditions: unknown[]; expiration: string };
    expect(grant.fields.bucket).toBe('aihub-sandbox-writing-chart-staging');
    expect(grant.fields.key).toBe(STAGING_KEY);
    expect(grant.fields['Content-Type']).toBe('image/png');
    expect(policy.conditions).toContainEqual([
      'content-length-range',
      1_024,
      1_024,
    ]);
    expect(policy.conditions).toContainEqual({ 'Content-Type': 'image/png' });
    expect(Date.parse(policy.expiration)).toBeGreaterThan(
      Date.now() + 4 * 60_000,
    );
    expect(Date.parse(policy.expiration)).toBeLessThanOrEqual(
      grant.expiresAt.getTime() + 1_000,
    );
  });

  it('reads one bounded, ETag-matched object from private staging', async () => {
    const image = Buffer.alloc(160_000, 0x61);
    const send = jest.fn().mockImplementation(async (raw: unknown) => {
      const command = raw as {
        readonly constructor: { readonly name: string };
        readonly input: {
          readonly IfMatch?: string;
          readonly Range?: string;
          readonly Bucket?: string;
          readonly Key?: string;
        };
      };
      if (command.constructor.name === 'HeadObjectCommand') {
        return {
          ContentType: 'image/png',
          ContentLength: image.length,
          ETag: '"verified-etag"',
        };
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(command.input.Range ?? '');
      if (
        command.constructor.name !== 'GetObjectCommand' ||
        command.input.IfMatch !== '"verified-etag"' ||
        match === null
      ) {
        throw new Error('unexpected storage command');
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      const bytes = image.subarray(start, end + 1);
      return {
        ETag: '"verified-etag"',
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
      bytes: image,
    });
    expect(send).toHaveBeenCalledTimes(2);
    const commands = send.mock.calls.map(
      ([command]) =>
        command as {
          constructor: { readonly name: string };
          input: Record<string, unknown>;
        },
    );
    expect(commands.map(({ constructor }) => constructor.name)).toEqual(
      expect.arrayContaining(['HeadObjectCommand', 'GetObjectCommand']),
    );
    expect(commands.map(({ input }) => input)).toContainEqual(
      expect.objectContaining({
        Bucket: 'aihub-sandbox-writing-chart-staging',
        Key: STAGING_KEY,
        Range: `bytes=0-${image.length - 1}`,
        IfMatch: '"verified-etag"',
      }),
    );
  });

  it('does not download a staging object larger than the upload limit', async () => {
    const send = jest.fn().mockResolvedValue({
      ContentType: 'image/png',
      ContentLength: WRITING_CHART_MAX_BYTES + 1,
      ETag: '"oversized"',
    });
    const adapter = createStorage(send);

    await expect(
      adapter.inspectObject({
        environment: 'sandbox',
        stagingKey: STAGING_KEY,
        byteSize: WRITING_CHART_MAX_BYTES + 1,
      }),
    ).resolves.toMatchObject({
      contentType: 'image/png',
      byteSize: WRITING_CHART_MAX_BYTES + 1,
      bytes: new Uint8Array(),
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('publishes only prepared bytes to the environment-isolated public bucket', async () => {
    const send = jest.fn().mockResolvedValue({});
    const adapter = createStorage(send);
    const bytes = Buffer.from('re-encoded-chart');

    await adapter.publishObject({
      environment: 'sandbox',
      stagingKey: STAGING_KEY,
      publishedKey: PUBLISHED_KEY,
      contentType: 'image/webp',
      bytes,
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command).toMatchObject({
      input: {
        Bucket: 'aihub-sandbox-writing-charts',
        Key: PUBLISHED_KEY,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: 'image/webp',
        ContentDisposition: 'inline',
      },
    });
    const url = adapter.publicUrl({
      environment: 'sandbox',
      publishedKey: PUBLISHED_KEY,
    });
    expect(url).toBe(
      `https://s3.wispace.app/aihub-sandbox-writing-charts/${PUBLISHED_KEY}`,
    );
    expect(url).not.toContain('?');
    expect(() =>
      adapter.publicUrl({
        environment: 'production',
        publishedKey: PUBLISHED_KEY,
      }),
    ).toThrow('Writing chart storage is unavailable');
  });

  it('uses the Production public bucket in shared-host URLs', () => {
    const adapter = createStorage(jest.fn(), {
      environment: 'production',
      stagingBucket: 'aihub-writing-chart-staging',
      publicBucket: 'aihub-writing-charts',
    });

    expect(
      adapter.publicUrl({
        environment: 'production',
        publishedKey: PUBLISHED_KEY,
      }),
    ).toBe(`https://s3.wispace.app/aihub-writing-charts/${PUBLISHED_KEY}`);
  });

  it('rejects shared media buckets and public origins other than the configured S3 host', async () => {
    for (const options of [
      { publicBucket: 'aihub-user-assets' },
      { publicBaseUrl: undefined },
      { publicBaseUrl: 'https://charts.aihubproduction.com' },
      { publicBaseUrl: 'https://media.wispace.app' },
      { publicBaseUrl: 'https://s3.wispace.app/charts' },
      { publicBaseUrl: 'https://s3.wispace.app:8443' },
      { publicBaseUrl: 'http://s3.wispace.app' },
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
