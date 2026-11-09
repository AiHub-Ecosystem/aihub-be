import { Readable } from 'node:stream';
import { createSeaweedFsS3Client } from '@/modules/secrets/infrastructure/seaweedfs-s3-client.factory';
import { SPEAKING_AUDIO_MAX_BYTES } from '@/modules/speaking/domain/speaking-audio-asset';
import { S3SpeakingAudioAssetStorage } from './s3-speaking-audio-asset.storage';

const KEY =
  'orgs/org_01J00000000000000000000001/speaking/aud_01J00000000000000000000001/original';
const STAGING_KEY = KEY.replace(/original$/, 'upload');

function storage(
  send: jest.Mock<Promise<unknown>, [unknown]> = jest
    .fn<Promise<unknown>, [unknown]>()
    .mockResolvedValue({}),
  options: ConstructorParameters<typeof S3SpeakingAudioAssetStorage>[1] = {},
) {
  return new S3SpeakingAudioAssetStorage(
    createSeaweedFsS3Client({
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret-key',
      },
    }),
    {
      productionBucket: 'aihub-speaking-recordings',
      sandboxBucket: 'aihub-sandbox-speaking-recordings',
      client: { send },
      now: () => new Date('2026-10-03T04:00:00.000Z'),
      ...options,
    },
  );
}

describe('S3SpeakingAudioAssetStorage', () => {
  it('presigns a five-minute PUT with content type and exact length signed', async () => {
    const adapter = storage();

    const result = await adapter.createUploadUrl({
      environment: 'production',
      objectKey: STAGING_KEY,
      contentType: 'audio/wav',
      byteSize: 1_024,
    });
    const url = new URL(result.url);

    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('s3.wispace.app');
    expect(url.pathname).toContain('/aihub-speaking-recordings/');
    expect(url.pathname.endsWith(`/${STAGING_KEY}`)).toBe(true);
    expect(url.pathname.endsWith(`/${KEY}`)).toBe(false);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain(
      'content-type',
    );
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain(
      'content-length',
    );
    expect(result.expiresAt).toEqual(new Date('2026-10-03T04:05:00.000Z'));
  });

  it('copies a staging object to the final key in the same private bucket', async () => {
    const send = jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({});
    const adapter = storage(send);

    await adapter.copyObject({
      environment: 'production',
      sourceObjectKey: STAGING_KEY,
      destinationObjectKey: KEY,
    });

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Bucket: 'aihub-speaking-recordings',
        CopySource: `aihub-speaking-recordings/${STAGING_KEY}`,
        Key: KEY,
      },
    });
  });

  it('refuses to presign the final object key', async () => {
    const adapter = storage();
    await expect(
      adapter.createUploadUrl({
        environment: 'production',
        objectKey: KEY,
        contentType: 'audio/wav',
        byteSize: 1_024,
      }),
    ).rejects.toMatchObject({ code: 'SPEAKING_AUDIO_STORAGE_UNAVAILABLE' });
  });

  it('selects the isolated Sandbox bucket and returns HEAD metadata', async () => {
    const send = jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({
      ContentType: 'audio/webm',
      ContentLength: 2_048,
    });
    const adapter = storage(send);

    await expect(
      adapter.describeObject({ environment: 'sandbox', objectKey: KEY }),
    ).resolves.toEqual({ contentType: 'audio/webm', byteSize: 2_048 });
    const command: unknown = send.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      input: { Bucket: 'aihub-sandbox-speaking-recordings', Key: KEY },
    });
  });

  it('reads bounded audio from the environment bucket into the v2 adapter shape', async () => {
    const send = jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({
      ContentLength: 11,
      Body: Readable.from([Buffer.from('audio bytes')]),
    });
    const adapter = storage(send);

    const result = await adapter.readObject({
      environment: 'sandbox',
      objectKey: KEY,
      contentType: 'audio/wav',
    });

    await expect(result.blob.arrayBuffer()).resolves.toEqual(
      Uint8Array.from(Buffer.from('audio bytes')).buffer,
    );
    expect(result).toMatchObject({
      filename: 'audio.wav',
      contentType: 'audio/wav',
    });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Bucket: 'aihub-sandbox-speaking-recordings',
        Key: KEY,
      },
    });
  });

  it('maps a missing audio object to NOT_FOUND without exposing its key', async () => {
    const missing = Object.assign(new Error('missing'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const adapter = storage(
      jest.fn<Promise<unknown>, [unknown]>().mockRejectedValue(missing),
    );

    const read = adapter.readObject({
      environment: 'production',
      objectKey: KEY,
      contentType: 'audio/wav',
    });
    await expect(read).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(read).rejects.not.toThrow(KEY);
  });

  it('refuses an oversized object and closes its response stream', async () => {
    const body = new Readable({ read() {} });
    const destroy = jest.spyOn(body, 'destroy');
    const send = jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({
      ContentLength: SPEAKING_AUDIO_MAX_BYTES + 1,
      Body: body,
    });
    const adapter = storage(send);

    await expect(
      adapter.readObject({
        environment: 'production',
        objectKey: KEY,
        contentType: 'audio/wav',
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(destroy).toHaveBeenCalled();
  });

  it('treats a missing object as absent and an already-missing delete as success', async () => {
    const missing = Object.assign(new Error('missing'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const send = jest
      .fn<Promise<unknown>, [unknown]>()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(missing);
    const adapter = storage(send);

    await expect(
      adapter.describeObject({ environment: 'production', objectKey: KEY }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.deleteObject({ environment: 'production', objectKey: KEY }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('fails closed when SeaweedFS credentials are missing', async () => {
    const adapter = new S3SpeakingAudioAssetStorage(undefined, {
      productionBucket: 'aihub-speaking-recordings',
      sandboxBucket: 'aihub-sandbox-speaking-recordings',
    });
    await expect(
      adapter.describeObject({ environment: 'production', objectKey: KEY }),
    ).rejects.toMatchObject({ code: 'SPEAKING_AUDIO_STORAGE_UNAVAILABLE' });
  });

  it('fails closed only for the environment whose private bucket is missing', async () => {
    const adapter = storage(undefined, { productionBucket: '' });

    await expect(
      adapter.describeObject({ environment: 'production', objectKey: KEY }),
    ).rejects.toMatchObject({ code: 'SPEAKING_AUDIO_STORAGE_UNAVAILABLE' });
    await expect(
      adapter.describeObject({ environment: 'sandbox', objectKey: KEY }),
    ).resolves.toEqual({ contentType: undefined, byteSize: undefined });
  });

  it('rejects sample, Avatar, and non-approved bucket configuration', async () => {
    for (const bucket of [
      'aihub-speaking-samples',
      'aihub-user-assets',
      'another-bucket',
    ]) {
      const adapter = new S3SpeakingAudioAssetStorage(
        createSeaweedFsS3Client({
          credentials: { accessKeyId: 'access', secretAccessKey: 'secret' },
        }),
        {
          productionBucket: bucket,
          sandboxBucket: 'aihub-sandbox-speaking-recordings',
        },
      );
      await expect(
        adapter.deleteObject({ environment: 'production', objectKey: KEY }),
      ).rejects.toMatchObject({ code: 'SPEAKING_AUDIO_STORAGE_UNAVAILABLE' });
    }
  });

  it('rejects path traversal without calling the SDK client', async () => {
    const send = jest.fn<Promise<unknown>, [unknown]>();
    const adapter = storage(send);

    await expect(
      adapter.deleteObject({
        environment: 'production',
        objectKey: 'orgs/../speaking/private/original',
      }),
    ).rejects.toMatchObject({ code: 'SPEAKING_AUDIO_STORAGE_UNAVAILABLE' });
    expect(send).not.toHaveBeenCalled();
  });
});
