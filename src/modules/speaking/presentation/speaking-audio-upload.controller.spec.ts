import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '@/app.module';
import { AppError } from '@/common/errors/app-error';
import { SpeakingAudioUploadUrlResponseSchema } from '@/contracts/speaking/audio-upload';
import { SpeakingAudioAssetResponseSchema } from '@/contracts/speaking/audio-upload';
import { RATE_LIMITER } from '@/modules/gateway/application/rate-limiter.port';
import type { ApiKeyAuthenticatorPort } from '@/modules/identity/application/api-key-authenticator.port';
import { API_KEY_AUTHENTICATOR } from '@/modules/identity/application/api-key-authenticator.port';
import type { UserIdentityResolverPort } from '@/modules/identity/application/user-identity-resolver.port';
import { USER_IDENTITY_RESOLVER } from '@/modules/identity/application/user-identity-resolver.port';
import {
  SPEAKING_AUDIO_ASSET_STORAGE,
  SPEAKING_AUDIO_UPLOAD_CLOCK,
  SPEAKING_AUDIO_UPLOAD_REPOSITORY,
  type SpeakingAudioAssetStoragePort,
  type SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/speaking-audio-upload.port';
import type {
  SpeakingAudioAsset,
  SpeakingAudioUploadIntent,
} from '@/modules/speaking/domain/speaking-audio-asset';
import { SPEAKING_AUDIO_MAX_BYTES } from '@/modules/speaking/domain/speaking-audio-asset';

class FakeAudioUploadRepository implements SpeakingAudioUploadRepositoryPort {
  readonly intents = new Map<string, SpeakingAudioUploadIntent>();
  readonly assets = new Map<string, SpeakingAudioAsset>();

  async createIntent(intent: SpeakingAudioUploadIntent): Promise<void> {
    this.intents.set(intent.assetId, intent);
  }

  async findUpload(input: {
    readonly assetId: string;
    readonly organizationId: string;
    readonly endUserId: string;
    readonly environment: 'production' | 'sandbox';
  }) {
    const intent = this.intents.get(input.assetId);
    if (
      intent !== undefined &&
      intent.organizationId === input.organizationId &&
      intent.endUserId === input.endUserId &&
      intent.environment === input.environment
    ) {
      return { kind: 'intent' as const, intent };
    }
    const asset = this.assets.get(input.assetId);
    if (
      asset !== undefined &&
      asset.organizationId === input.organizationId &&
      asset.endUserId === input.endUserId &&
      asset.environment === input.environment
    ) {
      return { kind: 'asset' as const, asset };
    }
    return { kind: 'missing' as const };
  }

  async confirmRefreshableIntent(input: {
    readonly owner: {
      readonly assetId: string;
      readonly organizationId: string;
      readonly endUserId: string;
      readonly environment: 'production' | 'sandbox';
    };
    readonly now: Date;
  }): Promise<boolean> {
    const found = await this.findUpload(input.owner);
    return (
      found.kind === 'intent' &&
      found.intent.status === 'open' &&
      found.intent.expiresAt > input.now
    );
  }

  async rejectIntent(input: {
    readonly owner: {
      readonly assetId: string;
      readonly organizationId: string;
      readonly endUserId: string;
      readonly environment: 'production' | 'sandbox';
    };
    readonly now: Date;
  }): Promise<boolean> {
    const found = await this.findUpload(input.owner);
    if (
      found.kind !== 'intent' ||
      found.intent.status !== 'open' ||
      found.intent.expiresAt <= input.now
    )
      return false;
    this.intents.set(input.owner.assetId, {
      ...found.intent,
      status: 'rejected',
    });
    return true;
  }

  async removeRejectedIntent(owner: {
    readonly assetId: string;
    readonly organizationId: string;
    readonly endUserId: string;
    readonly environment: 'production' | 'sandbox';
  }): Promise<void> {
    const found = await this.findUpload(owner);
    if (found.kind === 'intent' && found.intent.status === 'rejected') {
      this.intents.delete(owner.assetId);
    }
  }

  async completeIntent(input: {
    readonly owner: {
      readonly assetId: string;
      readonly organizationId: string;
      readonly endUserId: string;
      readonly environment: 'production' | 'sandbox';
    };
    readonly now: Date;
    readonly asset: SpeakingAudioAsset;
  }): Promise<'created' | 'already_completed' | 'missing'> {
    const found = await this.findUpload(input.owner);
    if (found.kind === 'asset') return 'already_completed';
    if (
      found.kind !== 'intent' ||
      found.intent.status !== 'open' ||
      found.intent.expiresAt <= input.now
    ) {
      return 'missing';
    }
    this.assets.set(input.asset.assetId, input.asset);
    this.intents.delete(input.asset.assetId);
    return 'created';
  }

  async listCleanupCandidates(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly SpeakingAudioUploadIntent[]> {
    return [...this.intents.values()]
      .filter(
        (intent) =>
          intent.status === 'rejected' ||
          intent.expiresAt <= input.expiredBefore,
      )
      .filter(
        (intent) =>
          input.after === undefined ||
          intent.createdAt > input.after.createdAt ||
          (intent.createdAt.getTime() === input.after.createdAt.getTime() &&
            intent.assetId > input.after.assetId),
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.assetId.localeCompare(right.assetId),
      )
      .slice(0, input.limit);
  }

  async removeCleanupCandidate(input: {
    readonly intent: SpeakingAudioUploadIntent;
    readonly expiredBefore: Date;
  }): Promise<boolean> {
    const found = await this.findUpload(input.intent);
    if (
      found.kind !== 'intent' ||
      (found.intent.status !== 'rejected' &&
        found.intent.expiresAt > input.expiredBefore)
    ) {
      return false;
    }
    this.intents.delete(input.intent.assetId);
    return true;
  }
}

class FakeAudioAssetStorage implements SpeakingAudioAssetStoragePort {
  clock: () => Date = () => new Date();
  readonly signed: Array<{
    readonly environment: string;
    readonly objectKey: string;
    readonly contentType: string;
    readonly byteSize: number;
  }> = [];
  readonly objects = new Map<
    string,
    { contentType: string; byteSize: number }
  >();
  readonly deleted: string[] = [];
  readonly described: string[] = [];
  deleteFails = false;
  unavailable = false;

  async createUploadUrl(input: {
    readonly environment: 'production' | 'sandbox';
    readonly objectKey: string;
    readonly contentType: string;
    readonly byteSize: number;
  }) {
    this.signed.push({ ...input });
    return {
      url: `https://s3.wispace.app/${input.environment}/${input.objectKey}?sig=opaque`,
      expiresAt: new Date(this.clock().getTime() + 5 * 60 * 1000),
    };
  }

  async describeObject(input: {
    readonly environment: 'production' | 'sandbox';
    readonly objectKey: string;
  }) {
    this.described.push(input.objectKey);
    if (this.unavailable) {
      throw new AppError({
        code: 'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
        message: 'Speaking audio storage is unavailable',
        retryable: true,
      });
    }
    return this.objects.get(input.objectKey);
  }

  async deleteObject(input: {
    readonly environment: 'production' | 'sandbox';
    readonly objectKey: string;
  }): Promise<void> {
    if (this.deleteFails) throw new Error('storage unavailable');
    this.deleted.push(input.objectKey);
    this.objects.delete(input.objectKey);
  }
}

describe('Speaking Audio upload HTTP flow', () => {
  let app: NestFastifyApplication;
  let repository: FakeAudioUploadRepository;
  let storage: FakeAudioAssetStorage;
  let currentTime = new Date('2026-10-03T04:00:00.000Z');
  const originalSandboxHost = process.env.AIHUB_SANDBOX_HOST;

  beforeAll(async () => {
    process.env.AIHUB_SANDBOX_HOST = 'sandbox.test';
    const apiKeys: ApiKeyAuthenticatorPort = {
      authenticate: async ({ environment, value }) => ({
        organizationId:
          value === 'aihub_sk_other' ? 'org_other_audio' : 'org_audio_upload',
        apiKeyId: 'ak_audio_upload',
        environment,
        scopes: ['speaking.grade'],
        rateLimitRpm: 600,
        maxConcurrent: 20,
        monthlyRequestQuota: null,
        hardStopOnQuota: false,
      }),
    };
    const identities: UserIdentityResolverPort = {
      resolve: async ({ organizationId, value }) => ({
        userId: value,
        organizationId,
        scopes: [],
      }),
    };

    repository = new FakeAudioUploadRepository();
    storage = new FakeAudioAssetStorage();
    storage.clock = () => new Date(currentTime);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue(apiKeys)
      .overrideProvider(USER_IDENTITY_RESOLVER)
      .useValue(identities)
      .overrideProvider(RATE_LIMITER)
      .useValue({ consume: async () => ({ allowed: true }) })
      .overrideProvider(SPEAKING_AUDIO_UPLOAD_REPOSITORY)
      .useValue(repository)
      .overrideProvider(SPEAKING_AUDIO_ASSET_STORAGE)
      .useValue(storage)
      .overrideProvider(SPEAKING_AUDIO_UPLOAD_CLOCK)
      .useValue(() => new Date(currentTime))
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        genReqId: () => 'req_01J00000000000000000000000',
      }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    if (originalSandboxHost === undefined) {
      delete process.env.AIHUB_SANDBOX_HOST;
    } else {
      process.env.AIHUB_SANDBOX_HOST = originalSandboxHost;
    }
  });

  beforeEach(() => {
    currentTime = new Date('2026-10-03T04:00:00.000Z');
    storage.clock = () => new Date(currentTime);
    repository.intents.clear();
    repository.assets.clear();
    storage.signed.length = 0;
    storage.objects.clear();
    storage.deleted.length = 0;
    storage.described.length = 0;
    storage.deleteFails = false;
    storage.unavailable = false;
  });

  it.each(['audio/mp3', 'audio/x-wav', 'audio/x-m4a', 'application/ogg'])(
    'rejects unsupported MIME value %s before creating an upload intent',
    async (contentType) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/speaking/audio/uploads',
        headers: {
          host: 'sandbox.test',
          'x-api-key': 'aihub_sk_audio_upload_test',
          'x-user-identity': 'student-123',
        },
        payload: { content_type: contentType, byte_size: 100 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
    },
  );

  it('accepts the 100-byte minimum and rejects a declaration over 25 MiB', async () => {
    const headers = {
      host: 'sandbox.test',
      'x-api-key': 'aihub_sk_audio_upload_test',
      'x-user-identity': 'student-123',
    };
    const minimum = await app.inject({
      method: 'POST',
      url: '/v1/speaking/audio/uploads',
      headers,
      payload: { content_type: 'audio/ogg', byte_size: 100 },
    });
    const oversized = await app.inject({
      method: 'POST',
      url: '/v1/speaking/audio/uploads',
      headers,
      payload: {
        content_type: 'audio/ogg',
        byte_size: SPEAKING_AUDIO_MAX_BYTES + 1,
      },
    });

    expect(minimum.statusCode).toBe(201);
    expect(oversized.statusCode).toBe(413);
    expect(repository.intents.size).toBe(1);
  });

  it('creates an owner-bound intent and a signed URL for the server key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/speaking/audio/uploads',
      headers: {
        host: 'sandbox.test',
        'x-api-key': 'aihub_sk_audio_upload_test',
        'x-user-identity': 'student-123',
      },
      payload: { content_type: 'audio/wav', byte_size: 1_024 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect([
      ...Value.Errors(SpeakingAudioUploadUrlResponseSchema, body),
    ]).toEqual([]);
    expect(body.data).toMatchObject({
      upload_url: expect.stringMatching(/^https:\/\/s3\.wispace\.app\//),
      method: 'PUT',
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': '1024',
      },
    });
    expect(body.data.asset_id).toMatch(/^aud_[0-9A-HJKMNP-TV-Z]{26}$/);

    const assetId = body.data.asset_id as string;
    const intent = repository.intents.get(assetId);
    expect(intent).toBeDefined();
    if (intent === undefined)
      throw new Error('upload intent was not persisted');
    expect(intent).toMatchObject({
      assetId,
      organizationId: 'org_audio_upload',
      endUserId: 'student-123',
      environment: 'sandbox',
      objectKey: `orgs/org_audio_upload/speaking/${assetId}/original`,
      contentType: 'audio/wav',
      byteSize: 1_024,
      status: 'open',
    });
    expect(intent.expiresAt.getTime() - intent.createdAt.getTime()).toBe(
      60 * 60 * 1000,
    );
    expect(storage.signed).toEqual([
      {
        environment: 'sandbox',
        objectKey: intent.objectKey,
        contentType: 'audio/wav',
        byteSize: 1_024,
      },
    ]);
    expect(repository.assets.size).toBe(0);
    expect(response.body).not.toContain('student-123');
  });

  it('refreshes only for the same owner and leaves the intent deadline unchanged', async () => {
    const headers = {
      host: 'sandbox.test',
      'x-api-key': 'aihub_sk_audio_upload_test',
      'x-user-identity': 'student-123',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/speaking/audio/uploads',
      headers,
      payload: { content_type: 'audio/webm', byte_size: 2_048 },
    });
    const assetId = created.json().data.asset_id as string;
    const before = repository.intents.get(assetId);
    if (before === undefined)
      throw new Error('upload intent was not persisted');

    const refreshed = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/refresh`,
      headers,
    });

    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().data).toMatchObject({
      asset_id: assetId,
      method: 'PUT',
      headers: {
        'Content-Type': 'audio/webm',
        'Content-Length': '2048',
      },
      intent_expires_at: before.expiresAt.toISOString(),
    });
    expect(storage.signed).toHaveLength(2);
    expect(storage.signed[0]).toEqual(storage.signed[1]);
    expect(repository.intents.get(assetId)?.expiresAt).toEqual(
      before.expiresAt,
    );

    const wrongOwner = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/refresh`,
      headers: { ...headers, 'x-user-identity': 'different-student' },
    });

    expect(wrongOwner.statusCode).toBe(404);
    expect(storage.signed).toHaveLength(2);
  });

  it('refuses refresh and completion after the intent expiry', async () => {
    const headers = {
      host: 'sandbox.test',
      'x-api-key': 'aihub_sk_audio_upload_test',
      'x-user-identity': 'student-123',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/speaking/audio/uploads',
      headers,
      payload: { content_type: 'audio/wav', byte_size: 512 },
    });
    const assetId = created.json().data.asset_id as string;
    currentTime = new Date(currentTime.getTime() + 60 * 60 * 1000);

    const refresh = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/refresh`,
      headers,
    });
    const complete = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/complete`,
      headers,
    });

    expect(refresh.statusCode).toBe(404);
    expect(complete.statusCode).toBe(404);
    expect(storage.signed).toHaveLength(1);
    expect(storage.described).toEqual([]);
    expect(repository.intents.get(assetId)?.status).toBe('open');
    expect(repository.assets.has(assetId)).toBe(false);
  });

  it('records only a verified object and makes successful completion idempotent', async () => {
    const headers = {
      host: 'sandbox.test',
      'x-api-key': 'aihub_sk_audio_upload_test',
      'x-user-identity': 'student-123',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/speaking/audio/uploads',
      headers,
      payload: { content_type: 'audio/wav', byte_size: 1_024 },
    });
    const assetId = created.json().data.asset_id as string;
    const intent = repository.intents.get(assetId);
    if (intent === undefined)
      throw new Error('upload intent was not persisted');
    storage.objects.set(intent.objectKey, {
      contentType: 'audio/wav',
      byteSize: 1_024,
    });

    const first = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/complete`,
      headers,
    });

    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    expect([
      ...Value.Errors(SpeakingAudioAssetResponseSchema, first.json()),
    ]).toEqual([]);
    const accepted = repository.assets.get(assetId);
    if (accepted === undefined) throw new Error('Audio asset was not recorded');
    expect(accepted).toMatchObject({
      assetId,
      organizationId: 'org_audio_upload',
      endUserId: 'student-123',
      environment: 'sandbox',
      objectKey: intent.objectKey,
      contentType: 'audio/wav',
      byteSize: 1_024,
    });
    expect(
      accepted.retentionExpiresAt.getTime() - accepted.acceptedAt.getTime(),
    ).toBe(30 * 24 * 60 * 60 * 1000);
    expect(repository.intents.has(assetId)).toBe(false);

    const repeat = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/complete`,
      headers,
    });

    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().data).toEqual(first.json().data);
    expect(storage.described).toEqual([intent.objectKey]);
    expect(repository.assets.size).toBe(1);
  });

  it('keeps a missing object retryable, but refuses another Organization or End-User', async () => {
    const headers = {
      host: 'sandbox.test',
      'x-api-key': 'aihub_sk_audio_upload_test',
      'x-user-identity': 'student-123',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/speaking/audio/uploads',
      headers,
      payload: { content_type: 'audio/ogg', byte_size: 1_200 },
    });
    const assetId = created.json().data.asset_id as string;
    const intent = repository.intents.get(assetId);
    if (intent === undefined)
      throw new Error('upload intent was not persisted');

    const otherEndUser = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/complete`,
      headers: { ...headers, 'x-user-identity': 'other-student' },
    });
    const otherOrganization = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/complete`,
      headers: { ...headers, 'x-api-key': 'aihub_sk_other' },
    });
    expect(otherEndUser.statusCode).toBe(404);
    expect(otherOrganization.statusCode).toBe(404);
    expect(storage.described).toEqual([]);

    const missing = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/complete`,
      headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(repository.intents.get(assetId)?.status).toBe('open');

    storage.objects.set(intent.objectKey, {
      contentType: 'audio/ogg',
      byteSize: 1_200,
    });
    const retried = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/complete`,
      headers,
    });
    expect(retried.statusCode).toBe(201);
    expect(repository.assets.has(assetId)).toBe(true);
  });

  it.each([
    ['wrong stored type', { contentType: 'audio/mpeg', byteSize: 1_024 }, 400],
    ['undersized object', { contentType: 'audio/wav', byteSize: 99 }, 400],
    [
      'oversized object',
      { contentType: 'audio/wav', byteSize: SPEAKING_AUDIO_MAX_BYTES + 1 },
      413,
    ],
    ['unexpected size', { contentType: 'audio/wav', byteSize: 1_023 }, 400],
  ])(
    'rejects and deletes an object with %s',
    async (_, stored, expectedStatus) => {
      const headers = {
        host: 'sandbox.test',
        'x-api-key': 'aihub_sk_audio_upload_test',
        'x-user-identity': 'student-123',
      };
      const created = await app.inject({
        method: 'POST',
        url: '/v1/speaking/audio/uploads',
        headers,
        payload: { content_type: 'audio/wav', byte_size: 1_024 },
      });
      const assetId = created.json().data.asset_id as string;
      const intent = repository.intents.get(assetId);
      if (intent === undefined)
        throw new Error('upload intent was not persisted');
      storage.objects.set(intent.objectKey, stored);

      const response = await app.inject({
        method: 'POST',
        url: `/v1/speaking/audio/uploads/${assetId}/complete`,
        headers,
      });

      expect(response.statusCode).toBe(expectedStatus);
      expect(storage.deleted).toEqual([intent.objectKey]);
      expect(repository.intents.has(assetId)).toBe(false);
      expect(repository.assets.has(assetId)).toBe(false);
    },
  );

  it('retains a rejected intent when best-effort object deletion fails', async () => {
    const headers = {
      host: 'sandbox.test',
      'x-api-key': 'aihub_sk_audio_upload_test',
      'x-user-identity': 'student-123',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/speaking/audio/uploads',
      headers,
      payload: { content_type: 'audio/wav', byte_size: 1_024 },
    });
    const assetId = created.json().data.asset_id as string;
    const intent = repository.intents.get(assetId);
    if (intent === undefined)
      throw new Error('upload intent was not persisted');
    storage.objects.set(intent.objectKey, {
      contentType: 'audio/ogg',
      byteSize: 1_024,
    });
    storage.deleteFails = true;

    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/complete`,
      headers,
    });
    const repeated = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/complete`,
      headers,
    });

    expect(rejected.statusCode).toBe(400);
    expect(repeated.statusCode).toBe(404);
    expect(repository.intents.get(assetId)?.status).toBe('rejected');
    expect(repository.assets.has(assetId)).toBe(false);
  });

  it('leaves a valid intent open when object storage is unavailable', async () => {
    const headers = {
      host: 'sandbox.test',
      'x-api-key': 'aihub_sk_audio_upload_test',
      'x-user-identity': 'student-123',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/speaking/audio/uploads',
      headers,
      payload: { content_type: 'audio/wav', byte_size: 1_024 },
    });
    const assetId = created.json().data.asset_id as string;
    const intent = repository.intents.get(assetId);
    if (intent === undefined)
      throw new Error('upload intent was not persisted');
    storage.unavailable = true;

    const response = await app.inject({
      method: 'POST',
      url: `/v1/speaking/audio/uploads/${assetId}/complete`,
      headers,
    });

    expect(response.statusCode).toBe(503);
    expect(repository.intents.get(assetId)?.status).toBe('open');
    expect(repository.assets.has(assetId)).toBe(false);
  });
});
