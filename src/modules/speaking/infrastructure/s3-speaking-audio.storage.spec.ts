import type {
  RuntimeSecretProvider,
  RuntimeSecretSnapshot,
} from '@/modules/secrets/application/runtime-secret-provider.port';
import { S3SpeakingAudioStorage } from './s3-speaking-audio.storage';

function provider(
  seaweedfs?: RuntimeSecretSnapshot['seaweedfs'],
): RuntimeSecretProvider {
  return {
    getSnapshot: (): RuntimeSecretSnapshot => ({
      aiSpeaking: { clientId: 'client', secretKey: 'secret' },
      aiWriting: { token: 'token' },
      resend: { apiKey: 'resend-api-key' },
      userAccessJwt: {
        privateKeyPem: 'private-key',
        keyId: 'key-id',
      },
      ...(seaweedfs === undefined ? {} : { seaweedfs }),
    }),
  };
}

describe('S3SpeakingAudioStorage', () => {
  it('fails closed when SeaweedFS credentials are not configured', async () => {
    const storage = new S3SpeakingAudioStorage(provider());

    await expect(
      storage.getReadUrl('speaking-samples/part-1/sample.webm'),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('creates an approved presigned URL for a trusted object key', async () => {
    const storage = new S3SpeakingAudioStorage(
      provider({ accessKeyId: 'access', secretAccessKey: 'secret' }),
      { bucket: 'test-speaking-samples', expiresInSeconds: 60 },
    );

    const value = await storage.getReadUrl(
      'speaking-samples/part-1/sample.webm',
    );
    const url = new URL(value);

    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('s3.wispace.app');
    expect(url.pathname).toContain('/test-speaking-samples/');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('rejects path traversal in object keys', async () => {
    const storage = new S3SpeakingAudioStorage(
      provider({ accessKeyId: 'access', secretAccessKey: 'secret' }),
    );

    await expect(storage.getReadUrl('../private.mp3')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});
