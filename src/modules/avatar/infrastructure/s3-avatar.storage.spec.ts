import type {
  RuntimeSecretProvider,
  RuntimeSecretSnapshot,
} from '@/modules/secrets/application/runtime-secret-provider.port';

import {
  type AvatarStorageOptions,
  S3AvatarStorage,
} from './s3-avatar.storage';

const KEY =
  'users/usr_01J00000000000000000000000/avatar/ava_01J00000000000000000000001/original';
const NOW = new Date('2026-10-02T10:00:00.000Z');

function provider(
  seaweedfs: RuntimeSecretSnapshot['seaweedfs'] | null = {
    accessKeyId: 'access',
    secretAccessKey: 'super-secret-value',
  },
): RuntimeSecretProvider {
  return {
    getSnapshot: (): RuntimeSecretSnapshot => ({
      aiSpeaking: { clientId: 'client', secretKey: 'secret' },
      aiWriting: { token: 'token' },
      resend: { apiKey: 'resend-api-key' },
      userAccessJwt: { privateKeyPem: 'private-key', keyId: 'key-id' },
      ...(seaweedfs === null || seaweedfs === undefined ? {} : { seaweedfs }),
    }),
  };
}

function storage(
  options: AvatarStorageOptions = {},
  secrets: RuntimeSecretProvider = provider(),
): S3AvatarStorage {
  return new S3AvatarStorage(secrets, {
    bucket: 'aihub-user-assets',
    now: () => NOW,
    ...options,
  });
}

function clientAnswering(answer: () => Promise<unknown>) {
  const send = jest.fn((_command: { readonly input: unknown }) => answer());
  return { client: { send } as never, send };
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('S3AvatarStorage', () => {
  describe('upload URL', () => {
    it('presigns one PUT with the content type, length, and cache header in the signature', async () => {
      const { url, expiresAt } = await storage().createUploadUrl({
        objectKey: KEY,
        contentType: 'image/png',
        byteSize: 1234,
      });

      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.hostname).toBe('s3.wispace.app');
      expect(parsed.pathname).toBe(`/aihub-user-assets/${KEY}`);
      expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(
        parsed.searchParams.get('X-Amz-SignedHeaders')?.split(';'),
      ).toEqual(
        expect.arrayContaining([
          'cache-control',
          'content-length',
          'content-type',
          'host',
        ]),
      );
      expect(expiresAt).toEqual(new Date('2026-10-02T10:05:00.000Z'));
    });

    it('never puts the secret key in the URL', async () => {
      const { url } = await storage().createUploadUrl({
        objectKey: KEY,
        contentType: 'image/png',
        byteSize: 1,
      });

      expect(url).not.toContain('super-secret-value');
    });

    it.each([
      '../users/x',
      'orgs/org_x/speaking/a/original',
      'users/a b/avatar',
      'users/x?y',
    ])('refuses the key %s before signing', async (objectKey) => {
      await expect(
        storage().createUploadUrl({
          objectKey,
          contentType: 'image/png',
          byteSize: 1,
        }),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    });
  });

  describe('public URL', () => {
    it('is the approved origin, then the bucket, then the key', () => {
      expect(storage().publicUrl(KEY)).toBe(
        `https://s3.wispace.app/aihub-user-assets/${KEY}`,
      );
    });

    it('carries no signature or credential', () => {
      expect(storage().publicUrl(KEY)).not.toMatch(
        /X-Amz|Signature|access|super-secret-value/,
      );
    });

    it.each(['../users/x', 'orgs/org_x/speaking/a/original', 'users/x?y'])(
      'refuses the key %s',
      (objectKey) => {
        expect(thrown(() => storage().publicUrl(objectKey))).toMatchObject({
          code: 'INTERNAL_ERROR',
        });
      },
    );
  });

  describe('configuration', () => {
    const originalBucket = process.env.SEAWEEDFS_USER_ASSET_BUCKET;

    afterEach(() => {
      if (originalBucket === undefined) {
        delete process.env.SEAWEEDFS_USER_ASSET_BUCKET;
      } else {
        process.env.SEAWEEDFS_USER_ASSET_BUCKET = originalBucket;
      }
    });

    it.each([
      [
        'no credentials',
        () => new S3AvatarStorage(provider(null), { bucket: 'b' }),
      ],
      [
        'no bucket',
        () => {
          delete process.env.SEAWEEDFS_USER_ASSET_BUCKET;
          return new S3AvatarStorage(provider());
        },
      ],
      [
        'a blank bucket',
        () => new S3AvatarStorage(provider(), { bucket: '  ' }),
      ],
      [
        'an unapproved endpoint',
        () => storage({ endpoint: 'https://evil.example' }),
      ],
      [
        'an http endpoint',
        () => storage({ endpoint: 'http://s3.wispace.app' }),
      ],
    ])(
      'answers storage unavailable on every call with %s',
      async (_, build) => {
        const unconfigured = build();

        await expect(
          unconfigured.createUploadUrl({
            objectKey: KEY,
            contentType: 'image/png',
            byteSize: 1,
          }),
        ).rejects.toMatchObject({
          code: 'AVATAR_STORAGE_UNAVAILABLE',
          retryable: true,
        });
        await expect(unconfigured.describeObject(KEY)).rejects.toMatchObject({
          code: 'AVATAR_STORAGE_UNAVAILABLE',
        });
        await expect(unconfigured.deleteObject(KEY)).rejects.toMatchObject({
          code: 'AVATAR_STORAGE_UNAVAILABLE',
        });
        expect(thrown(() => unconfigured.publicUrl(KEY))).toMatchObject({
          code: 'AVATAR_STORAGE_UNAVAILABLE',
        });
      },
    );

    it('reads the bucket from SEAWEEDFS_USER_ASSET_BUCKET', async () => {
      process.env.SEAWEEDFS_USER_ASSET_BUCKET = 'from-env-bucket';

      const { url } = await new S3AvatarStorage(provider()).createUploadUrl({
        objectKey: KEY,
        contentType: 'image/png',
        byteSize: 1,
      });

      expect(new URL(url).pathname).toBe(`/from-env-bucket/${KEY}`);
    });
  });

  describe('describing an object', () => {
    it('reports what landed', async () => {
      const { client, send } = clientAnswering(async () => ({
        ContentType: 'image/webp',
        ContentLength: 2048,
      }));

      await expect(storage({ client }).describeObject(KEY)).resolves.toEqual({
        contentType: 'image/webp',
        byteSize: 2048,
      });
      expect(send.mock.calls[0]?.[0]?.input).toEqual({
        Bucket: 'aihub-user-assets',
        Key: KEY,
      });
    });

    it.each([
      ['a NotFound error', { name: 'NotFound' }],
      ['a 404 status', { name: 'Unknown', $metadata: { httpStatusCode: 404 } }],
    ])('reports nothing for %s', async (_, error) => {
      const { client } = clientAnswering(async () => {
        throw error;
      });

      await expect(
        storage({ client }).describeObject(KEY),
      ).resolves.toBeUndefined();
    });

    it('maps any other failure to storage unavailable', async () => {
      const { client } = clientAnswering(async () => {
        throw new Error('connect ECONNREFUSED');
      });

      await expect(
        storage({ client }).describeObject(KEY),
      ).rejects.toMatchObject({
        code: 'AVATAR_STORAGE_UNAVAILABLE',
        retryable: true,
      });
    });
  });

  describe('deleting an object', () => {
    it('deletes the named key in the Avatar bucket', async () => {
      const { client, send } = clientAnswering(async () => ({}));

      await storage({ client }).deleteObject(KEY);

      expect(send.mock.calls[0]?.[0]?.input).toEqual({
        Bucket: 'aihub-user-assets',
        Key: KEY,
      });
    });

    it('maps a failure to storage unavailable', async () => {
      const { client } = clientAnswering(async () => {
        throw new Error('timeout');
      });

      await expect(storage({ client }).deleteObject(KEY)).rejects.toMatchObject(
        {
          code: 'AVATAR_STORAGE_UNAVAILABLE',
        },
      );
    });
  });
});
