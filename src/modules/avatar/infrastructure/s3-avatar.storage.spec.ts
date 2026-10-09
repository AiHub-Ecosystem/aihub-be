import type { ListedAvatarObject } from '@/modules/avatar/application/avatar-storage.port';
import type {
  RuntimeSecretProvider,
  RuntimeSecretSnapshot,
} from '@/modules/secrets/application/runtime-secret-provider.port';
import { createSeaweedFsS3Client } from '@/modules/secrets/infrastructure/seaweedfs-s3-client.factory';

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
      emailOutbox: { currentKeyId: 'test', keys: { test: 'k'.repeat(44) } },
      ...(seaweedfs === null || seaweedfs === undefined ? {} : { seaweedfs }),
    }),
  };
}

function storage(
  options: AvatarStorageOptions = {},
  secrets: RuntimeSecretProvider = provider(),
): S3AvatarStorage {
  return new S3AvatarStorage(
    createSeaweedFsS3Client({
      credentials: secrets.getSnapshot().seaweedfs,
    }),
    {
      bucket: 'aihub-user-assets',
      now: () => NOW,
      ...options,
    },
  );
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
    it('signs content type and cache policy, but not browser-managed length', async () => {
      const { url, expiresAt } = await storage().createUploadUrl({
        objectKey: KEY,
        contentType: 'image/png',
      });

      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.hostname).toBe('s3.wispace.app');
      expect(parsed.pathname).toBe(`/aihub-user-assets/${KEY}`);
      expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(
        parsed.searchParams.get('X-Amz-SignedHeaders')?.split(';'),
      ).toEqual(
        expect.arrayContaining(['cache-control', 'content-type', 'host']),
      );
      expect(
        parsed.searchParams.get('X-Amz-SignedHeaders')?.split(';'),
      ).not.toContain('content-length');
      expect(expiresAt).toEqual(new Date('2026-10-02T10:05:00.000Z'));
    });

    it('never puts the secret key in the URL', async () => {
      const { url } = await storage().createUploadUrl({
        objectKey: KEY,
        contentType: 'image/png',
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
    it.each([
      ['no credentials', () => new S3AvatarStorage(undefined, { bucket: 'b' })],
      [
        'no bucket',
        () =>
          new S3AvatarStorage(
            createSeaweedFsS3Client({
              credentials: provider().getSnapshot().seaweedfs,
            }),
          ),
      ],
      [
        'a blank bucket',
        () =>
          new S3AvatarStorage(
            createSeaweedFsS3Client({
              credentials: provider().getSnapshot().seaweedfs,
            }),
            { bucket: '  ' },
          ),
      ],
    ])(
      'answers storage unavailable on every call with %s',
      async (_, build) => {
        const unconfigured = build();

        await expect(
          unconfigured.createUploadUrl({
            objectKey: KEY,
            contentType: 'image/png',
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
        await expect(
          (async () => {
            for await (const _ of unconfigured.listObjects('users/')) {
              // never reached
            }
          })(),
        ).rejects.toMatchObject({ code: 'AVATAR_STORAGE_UNAVAILABLE' });
      },
    );

    it('uses the bucket supplied by the application configuration', async () => {
      const { url } = await storage({
        bucket: 'from-config-bucket',
      }).createUploadUrl({
        objectKey: KEY,
        contentType: 'image/png',
      });

      expect(new URL(url).pathname).toBe(`/from-config-bucket/${KEY}`);
    });
  });

  describe('describing an object', () => {
    it('reports what landed', async () => {
      const lastModified = new Date('2026-10-02T09:30:00.000Z');
      const { client, send } = clientAnswering(async () => ({
        ContentType: 'image/webp',
        ContentLength: 2048,
        LastModified: lastModified,
      }));

      await expect(storage({ client }).describeObject(KEY)).resolves.toEqual({
        contentType: 'image/webp',
        byteSize: 2048,
        lastModified,
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

  describe('listing objects', () => {
    const OLD = new Date('2026-10-01T00:00:00.000Z');

    async function collect(
      objects: AsyncIterable<ListedAvatarObject>,
    ): Promise<ListedAvatarObject[]> {
      const all: ListedAvatarObject[] = [];
      for await (const object of objects) {
        all.push(object);
      }
      return all;
    }

    it('follows every page and carries each key with its last-modified time', async () => {
      const pages = [
        {
          Contents: [
            { Key: 'users/a', LastModified: OLD },
            { Key: 'users/b', LastModified: OLD },
          ],
          IsTruncated: true,
          NextContinuationToken: 'page-2',
        },
        {
          Contents: [{ Key: 'users/c', LastModified: OLD }],
          IsTruncated: false,
        },
      ];
      const { client, send } = clientAnswering(async () => pages.shift());

      const listed = await collect(storage({ client }).listObjects('users/'));

      expect(listed).toEqual([
        { objectKey: 'users/a', lastModified: OLD },
        { objectKey: 'users/b', lastModified: OLD },
        { objectKey: 'users/c', lastModified: OLD },
      ]);
      expect(send.mock.calls.map((call) => call[0]?.input)).toEqual([
        { Bucket: 'aihub-user-assets', Prefix: 'users/' },
        {
          Bucket: 'aihub-user-assets',
          Prefix: 'users/',
          ContinuationToken: 'page-2',
        },
      ]);
    });

    it('lists an empty bucket as nothing', async () => {
      const { client } = clientAnswering(async () => ({ IsTruncated: false }));

      await expect(
        collect(storage({ client }).listObjects('users/')),
      ).resolves.toEqual([]);
    });

    it('stops at a truncated page that names no continuation token', async () => {
      const { client, send } = clientAnswering(async () => ({
        Contents: [{ Key: 'users/a' }],
        IsTruncated: true,
      }));

      const listed = await collect(storage({ client }).listObjects('users/'));

      expect(listed).toEqual([{ objectKey: 'users/a' }]);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('maps a failed page to storage unavailable', async () => {
      const { client } = clientAnswering(async () => {
        throw new Error('connect ECONNREFUSED');
      });

      await expect(
        collect(storage({ client }).listObjects('users/')),
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
