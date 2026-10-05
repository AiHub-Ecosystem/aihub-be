import type {
  RuntimeSecretProvider,
  RuntimeSecretSnapshot,
} from '@/modules/secrets/application/runtime-secret-provider.port';
import { S3SpeakingAudioAssetStorage } from './s3-speaking-audio-asset.storage';

const KEY =
  'orgs/org_01J00000000000000000000001/speaking/aud_01J00000000000000000000001/original';

function provider(
  seaweedfs?: RuntimeSecretSnapshot['seaweedfs'],
): RuntimeSecretProvider {
  return {
    getSnapshot: (): RuntimeSecretSnapshot => ({
      aiSpeaking: { clientId: 'client', secretKey: 'secret' },
      aiWriting: { token: 'token' },
      resend: { apiKey: 'resend-api-key' },
      userAccessJwt: { privateKeyPem: 'private-key', keyId: 'key-id' },
      emailOutbox: { currentKeyId: 'test', keys: { test: 'k'.repeat(44) } },
      ...(seaweedfs === undefined ? {} : { seaweedfs }),
    }),
  };
}

function storage(
  send: jest.Mock<Promise<unknown>, [unknown]> = jest
    .fn()
    .mockResolvedValue({}),
  options: ConstructorParameters<typeof S3SpeakingAudioAssetStorage>[1] = {},
) {
  return new S3SpeakingAudioAssetStorage(
    provider({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-key' }),
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
      objectKey: KEY,
      contentType: 'audio/wav',
      byteSize: 1_024,
    });
    const url = new URL(result.url);

    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('s3.wispace.app');
    expect(url.pathname).toContain('/aihub-speaking-recordings/');
    expect(url.pathname.endsWith(`/${KEY}`)).toBe(true);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain(
      'content-type',
    );
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain(
      'content-length',
    );
    expect(result.expiresAt).toEqual(new Date('2026-10-03T04:05:00.000Z'));
  });

  it('selects the isolated Sandbox bucket and returns HEAD metadata', async () => {
    const send = jest.fn().mockResolvedValue({
      ContentType: 'audio/webm',
      ContentLength: 2_048,
    });
    const adapter = storage(send);

    await expect(
      adapter.describeObject({ environment: 'sandbox', objectKey: KEY }),
    ).resolves.toEqual({ contentType: 'audio/webm', byteSize: 2_048 });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: { Bucket: 'aihub-sandbox-speaking-recordings', Key: KEY },
    });
  });

  it('treats a missing object as absent and an already-missing delete as success', async () => {
    const missing = Object.assign(new Error('missing'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const send = jest
      .fn()
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
    const adapter = new S3SpeakingAudioAssetStorage(provider(), {
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
        provider({ accessKeyId: 'access', secretAccessKey: 'secret' }),
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
    const send = jest.fn();
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
