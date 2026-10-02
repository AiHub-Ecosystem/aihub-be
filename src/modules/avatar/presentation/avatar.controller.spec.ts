import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '@/app.module';
import { AppError } from '@/common/errors/app-error';
import {
  AvatarResponseSchema,
  AvatarUploadResponseSchema,
} from '@/contracts/avatar/avatar';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  AVATAR_REPOSITORY,
  type AvatarRepositoryPort,
} from '@/modules/avatar/application/avatar-repository.port';
import {
  AVATAR_STORAGE,
  type AvatarStoragePort,
  type StoredAvatarObject,
} from '@/modules/avatar/application/avatar-storage.port';
import { InMemoryAvatarRepository } from '@/modules/avatar/testing/in-memory-avatar.repository';

const USER_ID = 'usr_01J00000000000000000000000';
const OTHER_USER_ID = 'usr_01J00000000000000000000009';
const REQUEST_ID = 'req_01J00000000000000000000000';
const UPLOADS_URL = '/v1/me/avatar/uploads';
const UPLOAD_URL =
  'https://s3.wispace.app/aihub-user-assets/users/usr_x/avatar/ava_x/original?X-Amz-Signature=sig';
const MiB = 1024 * 1024;

function storageUnavailable(): AppError {
  return new AppError({
    code: 'AVATAR_STORAGE_UNAVAILABLE',
    message: 'Avatar storage is unavailable',
    retryable: true,
  });
}

class FakeAvatarStorage implements AvatarStoragePort {
  readonly objects = new Map<string, StoredAvatarObject>();
  readonly signed: Array<{
    objectKey: string;
    contentType: string;
    byteSize: number;
  }> = [];
  readonly deleted: string[] = [];
  unavailable = false;
  deleteFails = false;

  async createUploadUrl(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly byteSize: number;
  }) {
    if (this.unavailable) throw storageUnavailable();
    this.signed.push({ ...input });
    return {
      url: UPLOAD_URL,
      expiresAt: new Date('2026-10-02T10:05:00.000Z'),
    };
  }

  async describeObject(objectKey: string) {
    if (this.unavailable) throw storageUnavailable();
    return this.objects.get(objectKey);
  }

  async deleteObject(objectKey: string) {
    if (this.deleteFails) throw storageUnavailable();
    this.deleted.push(objectKey);
    this.objects.delete(objectKey);
  }
}

describe('Avatar upload HTTP flow', () => {
  let app: NestFastifyApplication;
  let storage: FakeAvatarStorage;
  let repository: InMemoryAvatarRepository;
  let accountStatus: LocalAccountStatus = 'active';

  beforeAll(async () => {
    storage = new FakeAvatarStorage();
    repository = new InMemoryAvatarRepository();
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token: string) => {
        if (token === 'valid.token.value')
          return { userId: USER_ID, jti: 'jti_01' };
        if (token === 'other.token.value')
          return { userId: OTHER_USER_ID, jti: 'jti_02' };
        throw new Error('invalid token');
      },
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AVATAR_STORAGE)
      .useValue(storage)
      .overrideProvider(AVATAR_REPOSITORY)
      .useValue(repository satisfies AvatarRepositoryPort)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(userAccountStatus(() => accountStatus))
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => REQUEST_ID }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    accountStatus = 'active';
    storage.objects.clear();
    storage.signed.length = 0;
    storage.deleted.length = 0;
    storage.unavailable = false;
    storage.deleteFails = false;
    repository.avatars.clear();
  });

  function requestUpload(
    body: unknown = { content_type: 'image/png', byte_size: 1234 },
    token = 'valid.token.value',
  ) {
    return app.inject({
      method: 'POST',
      url: UPLOADS_URL,
      headers: { authorization: `Bearer ${token}` },
      payload: body as Record<string, unknown>,
    });
  }

  function complete(assetId: string, token = 'valid.token.value') {
    return app.inject({
      method: 'POST',
      url: `${UPLOADS_URL}/${assetId}/complete`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function uploadedAsset(
    object: StoredAvatarObject = { contentType: 'image/png', byteSize: 1234 },
  ): Promise<{ assetId: string; objectKey: string }> {
    const response = await requestUpload();
    const assetId = String(response.json().data.asset_id);
    const objectKey = `users/${USER_ID}/avatar/${assetId}/original`;
    storage.objects.set(objectKey, object);
    return { assetId, objectKey };
  }

  describe('requesting an upload URL', () => {
    it('signs one object under the caller and returns how to send it', async () => {
      const response = await requestUpload();

      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json();
      expect(Value.Check(AvatarUploadResponseSchema, body)).toBe(true);
      expect(body).toEqual({
        data: {
          asset_id: expect.stringMatching(/^ava_[0-9A-HJKMNP-TV-Z]{26}$/),
          upload_url: UPLOAD_URL,
          method: 'PUT',
          headers: { 'Content-Type': 'image/png', 'Content-Length': '1234' },
          expires_at: '2026-10-02T10:05:00.000Z',
        },
        meta: { request_id: REQUEST_ID },
      });
      expect(storage.signed).toEqual([
        {
          objectKey: `users/${USER_ID}/avatar/${body.data.asset_id}/original`,
          contentType: 'image/png',
          byteSize: 1234,
        },
      ]);
      expect(repository.avatars.size).toBe(0);
    });

    it.each([
      ['an SVG', { content_type: 'image/svg+xml', byte_size: 10 }],
      ['a GIF', { content_type: 'image/gif', byte_size: 10 }],
      ['a zero size', { content_type: 'image/png', byte_size: 0 }],
      ['a fractional size', { content_type: 'image/png', byte_size: 1.5 }],
      [
        'an unknown field',
        { content_type: 'image/png', byte_size: 1, key: 'x' },
      ],
      ['a missing type', { byte_size: 10 }],
    ])('refuses %s without signing anything', async (_, body) => {
      const response = await requestUpload(body);

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
      expect(storage.signed).toEqual([]);
    });

    it('refuses a declared size above 2 MiB as too large', async () => {
      const response = await requestUpload({
        content_type: 'image/jpeg',
        byte_size: 2 * MiB + 1,
      });

      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(storage.signed).toEqual([]);
    });

    it('accepts exactly 2 MiB', async () => {
      const response = await requestUpload({
        content_type: 'image/webp',
        byte_size: 2 * MiB,
      });

      expect(response.statusCode).toBe(201);
    });

    it('refuses an account that already has an Avatar', async () => {
      const { assetId } = await uploadedAsset();
      await complete(assetId);

      const response = await requestUpload();

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('AVATAR_EXISTS');
    });

    it('answers a retryable storage-unavailable error when storage fails', async () => {
      storage.unavailable = true;

      const response = await requestUpload();

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({
        code: 'AVATAR_STORAGE_UNAVAILABLE',
        retryable: true,
      });
    });
  });

  describe('completing an upload', () => {
    it('records the Avatar from what actually landed and describes it', async () => {
      const { assetId, objectKey } = await uploadedAsset();

      const response = await complete(assetId);

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(Value.Check(AvatarResponseSchema, body)).toBe(true);
      expect(body).toEqual({
        data: {
          asset_id: assetId,
          content_type: 'image/png',
          byte_size: 1234,
          accepted_at: expect.any(String),
        },
        meta: { request_id: REQUEST_ID },
      });
      expect(repository.avatars.get(USER_ID)).toMatchObject({
        assetId,
        userId: USER_ID,
        objectKey,
        contentType: 'image/png',
        byteSize: 1234,
      });
    });

    it('never exposes the object key, bucket, or a URL', async () => {
      const { assetId } = await uploadedAsset();

      const text = (await complete(assetId)).body;

      expect(text).not.toContain('users/');
      expect(text).not.toContain('aihub-user-assets');
      expect(text).not.toContain('https://');
    });

    it('answers a repeated completion with the same Avatar and 200', async () => {
      const { assetId } = await uploadedAsset();
      const first = await complete(assetId);

      const second = await complete(assetId);

      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
    });

    it('answers not found while the upload has not landed, and records nothing', async () => {
      const response = await requestUpload();
      const assetId = String(response.json().data.asset_id);

      const completed = await complete(assetId);

      expect(completed.statusCode).toBe(404);
      expect(completed.json().error.code).toBe('NOT_FOUND');
      expect(repository.avatars.size).toBe(0);
    });

    it('never reaches another account’s object', async () => {
      const { assetId } = await uploadedAsset();

      const response = await complete(assetId, 'other.token.value');

      expect(response.statusCode).toBe(404);
      expect(repository.avatars.size).toBe(0);
    });

    it.each(['not-an-id', 'ava_short', 'ava_01J0000000000000000000000I'])(
      'refuses the malformed asset id %s',
      async (assetId) => {
        const response = await complete(assetId);

        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('INVALID_REQUEST');
      },
    );

    it('refuses and deletes an object above 2 MiB', async () => {
      const { assetId, objectKey } = await uploadedAsset({
        contentType: 'image/png',
        byteSize: 2 * MiB + 1,
      });

      const response = await complete(assetId);

      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(storage.deleted).toEqual([objectKey]);
      expect(repository.avatars.size).toBe(0);
    });

    it.each([
      ['an unsupported type', { contentType: 'image/svg+xml', byteSize: 10 }],
      ['no type', { contentType: undefined, byteSize: 10 }],
      ['no size', { contentType: 'image/png', byteSize: undefined }],
      ['an empty object', { contentType: 'image/png', byteSize: 0 }],
    ])('refuses and deletes an object with %s', async (_, object) => {
      const { assetId, objectKey } = await uploadedAsset(object);

      const response = await complete(assetId);

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
      expect(storage.deleted).toEqual([objectKey]);
      expect(repository.avatars.size).toBe(0);
    });

    it('keeps the refusal when deleting the rejected object fails', async () => {
      const { assetId } = await uploadedAsset({
        contentType: 'image/svg+xml',
        byteSize: 10,
      });
      storage.deleteFails = true;

      const response = await complete(assetId);

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
    });

    it('refuses a second, different Avatar', async () => {
      const first = await uploadedAsset();
      await complete(first.assetId);
      const secondAssetId = 'ava_01J00000000000000000000077';
      storage.objects.set(`users/${USER_ID}/avatar/${secondAssetId}/original`, {
        contentType: 'image/png',
        byteSize: 10,
      });

      const response = await complete(secondAssetId);

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('AVATAR_EXISTS');
      expect(repository.avatars.get(USER_ID)?.assetId).toBe(first.assetId);
    });

    it('answers a retryable storage-unavailable error when storage fails', async () => {
      const { assetId } = await uploadedAsset();
      storage.unavailable = true;

      const response = await complete(assetId);

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('AVATAR_STORAGE_UNAVAILABLE');
      expect(repository.avatars.size).toBe(0);
    });
  });

  describe('authentication', () => {
    it.each([
      ['no token', undefined],
      ['an invalid token', 'Bearer nope'],
    ])('refuses %s on both routes', async (_, authorization) => {
      const headers = authorization === undefined ? {} : { authorization };
      const upload = await app.inject({
        method: 'POST',
        url: UPLOADS_URL,
        headers,
        payload: { content_type: 'image/png', byte_size: 1 },
      });
      const completion = await app.inject({
        method: 'POST',
        url: `${UPLOADS_URL}/ava_01J00000000000000000000077/complete`,
        headers,
      });

      expect(upload.statusCode).toBe(401);
      expect(completion.statusCode).toBe(401);
      expect(storage.signed).toEqual([]);
    });

    it('refuses an account that is not active before any URL is minted', async () => {
      accountStatus = 'disabled';

      const response = await requestUpload();

      expect(response.statusCode).toBe(401);
      expect(storage.signed).toEqual([]);
    });
  });
});
