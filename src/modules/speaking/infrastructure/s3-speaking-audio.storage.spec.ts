import { createSeaweedFsS3Client } from '@/modules/secrets/infrastructure/seaweedfs-s3-client.factory';
import { S3SpeakingAudioStorage } from './s3-speaking-audio.storage';

const configuredClient = () =>
  createSeaweedFsS3Client({
    credentials: { accessKeyId: 'access', secretAccessKey: 'secret' },
  });

describe('S3SpeakingAudioStorage', () => {
  it('fails closed when SeaweedFS credentials are not configured', async () => {
    const storage = new S3SpeakingAudioStorage(undefined, {
      bucket: 'aihub-speaking-samples',
    });

    await expect(
      storage.getReadUrl('speaking-samples/part-1/sample.webm'),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('creates an approved presigned URL for a trusted object key', async () => {
    const storage = new S3SpeakingAudioStorage(configuredClient(), {
      bucket: 'test-speaking-samples',
      expiresInSeconds: 60,
    });

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
    const storage = new S3SpeakingAudioStorage(configuredClient());

    await expect(storage.getReadUrl('../private.mp3')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});
