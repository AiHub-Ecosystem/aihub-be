import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MockAgent } from 'undici';

import { AppModule } from '@/app.module';
import { registerRequestLifecycle } from '@/common/http/request-lifecycle.hook';
import { generateRequestId } from '@/common/request-context/request-id';
import { RATE_LIMITER } from '@/modules/gateway/application/rate-limiter.port';
import { SANDBOX_DISPATCH_BUDGET } from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';
import { IDEMPOTENCY_REPOSITORY } from '@/modules/idempotency/application/idempotency-repository.port';
import { InMemoryIdempotencyRepository } from '@/modules/idempotency/testing/in-memory-idempotency.repository';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import {
  USER_IDENTITY_RESOLVER,
  type UserIdentityResolverPort,
} from '@/modules/identity/user-assertions/application/user-identity-resolver.port';
import { DISPATCH_ATTEMPT_RECORD } from '@/modules/metering/public/dispatch-attempts';
import { noOpDispatchAttemptRecord } from '@/modules/metering/testing/no-op-dispatch-attempt-record';
import {
  WRITING_CHART_UPLOAD_CLOCK,
  WRITING_CHART_UPLOAD_REPOSITORY,
  WRITING_CHART_UPLOAD_STORAGE,
  type WritingChartUploadRepositoryPort,
  type WritingChartUploadStoragePort,
} from '@/modules/writing/application/writing-chart-upload.port';
import {
  type WritingChartAsset,
  type WritingChartContentType,
  type WritingChartEnvironment,
  type WritingChartUploadIntent,
} from '@/modules/writing/domain/writing-chart-upload';

const FIXTURES = join(__dirname, '../fixtures/ai-writing');
const task1 = JSON.parse(
  readFileSync(join(FIXTURES, 'grade-task1.request.json'), 'utf8'),
) as { question: string; url: string; topic: string; essay: string };

const VALID_CHART_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
);

function chartBytes() {
  return {
    bytes: new Uint8Array(VALID_CHART_PNG),
    byteSize: VALID_CHART_PNG.length,
  };
}

class FakeRepository implements WritingChartUploadRepositoryPort {
  readonly rows = new Map<
    string,
    WritingChartUploadIntent | WritingChartAsset
  >();

  async createIntent(intent: WritingChartUploadIntent) {
    const recent = [...this.rows.values()].filter(
      (row) =>
        row.organizationId === intent.organizationId &&
        row.createdAt.getTime() > intent.createdAt.getTime() - 60 * 60 * 1000,
    );
    if (recent.length >= 5) return false;
    this.rows.set(intent.assetId, intent);
    return true;
  }

  async findUpload(owner: {
    readonly assetId: string;
    readonly organizationId: string;
    readonly endUserId: string;
    readonly environment: WritingChartEnvironment;
  }) {
    const row = this.rows.get(owner.assetId);
    if (
      row === undefined ||
      row.organizationId !== owner.organizationId ||
      row.endUserId !== owner.endUserId ||
      row.environment !== owner.environment
    )
      return { kind: 'missing' as const };
    return row.status === 'published'
      ? { kind: 'asset' as const, asset: row }
      : { kind: 'intent' as const, intent: row as WritingChartUploadIntent };
  }

  async rejectIntent(
    owner: Parameters<WritingChartUploadRepositoryPort['rejectIntent']>[0],
  ) {
    const found = await this.findUpload(owner);
    if (found.kind === 'intent' && found.intent.status === 'open') {
      this.rows.set(owner.assetId, { ...found.intent, status: 'rejected' });
    }
  }

  async beginPublication(input: {
    readonly owner: Parameters<
      WritingChartUploadRepositoryPort['findUpload']
    >[0];
    readonly now: Date;
  }): Promise<'started' | 'published' | 'limited' | 'missing'> {
    const found = await this.findUpload(input.owner);
    if (found.kind === 'asset') return 'published';
    if (
      found.kind !== 'intent' ||
      !['open', 'publishing'].includes(found.intent.status) ||
      found.intent.expiresAt <= input.now
    )
      return 'missing';
    if (found.intent.status === 'publishing') return 'started';
    const recent = [...this.rows.values()].filter(
      (row) =>
        row.organizationId === input.owner.organizationId &&
        (row.status === 'publishing' ||
          (row.status === 'published' &&
            row.publishedAt.getTime() > input.now.getTime() - 60 * 60 * 1000)),
    );
    if (recent.length >= 5) return 'limited';
    this.rows.set(found.intent.assetId, {
      ...found.intent,
      status: 'publishing',
    });
    return 'started';
  }

  async markPublished(input: {
    readonly owner: Parameters<
      WritingChartUploadRepositoryPort['findUpload']
    >[0];
    readonly now: Date;
    readonly imageUrl: string;
  }) {
    const found = await this.findUpload(input.owner);
    if (found.kind !== 'intent' || found.intent.status !== 'publishing')
      return undefined;
    const asset: WritingChartAsset = {
      ...found.intent,
      status: 'published',
      publishedAt: input.now,
      retentionExpiresAt: new Date(input.now.getTime() + 24 * 60 * 60 * 1000),
      imageUrl: input.imageUrl,
    };
    this.rows.set(asset.assetId, asset);
    return asset;
  }

  async releasePublication(
    owner: Parameters<WritingChartUploadRepositoryPort['findUpload']>[0],
  ) {
    const found = await this.findUpload(owner);
    if (found.kind === 'intent' && found.intent.status === 'publishing') {
      this.rows.set(owner.assetId, { ...found.intent, status: 'open' });
    }
  }

  async cleanupCandidates() {
    return [];
  }
  async removeCleanupCandidate() {
    return false;
  }
}

class FakeStorage implements WritingChartUploadStoragePort {
  readonly uploads: string[] = [];
  readonly published: string[] = [];
  readonly deletedStaging: string[] = [];
  readonly deletedPublished: string[] = [];
  activeInspections = 0;
  maxConcurrentInspections = 0;
  inspectionDelayMs = 0;
  readonly objects = new Map<
    string,
    {
      readonly contentType: string;
      readonly byteSize: number;
      readonly bytes: Uint8Array;
    }
  >();

  async createUploadUrl(input: {
    readonly stagingKey: string;
    readonly contentType: WritingChartContentType;
    readonly byteSize: number;
  }) {
    this.uploads.push(input.stagingKey);
    return {
      url: `https://s3.wispace.app/private/${input.stagingKey}?signature=opaque`,
      fields: { 'Content-Type': input.contentType },
      expiresAt: new Date('2026-10-14T00:05:00.000Z'),
    };
  }

  async inspectObject(input: { readonly stagingKey: string }): ReturnType<
    WritingChartUploadStoragePort['inspectObject']
  > {
    this.activeInspections += 1;
    this.maxConcurrentInspections = Math.max(
      this.maxConcurrentInspections,
      this.activeInspections,
    );
    try {
      if (this.inspectionDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.inspectionDelayMs),
        );
      }
      return this.objects.get(input.stagingKey);
    } finally {
      this.activeInspections -= 1;
    }
  }

  async publishObject(input: {
    readonly publishedKey: string;
    readonly bytes: Uint8Array;
  }): Promise<void> {
    this.published.push(input.publishedKey);
    this.publishedObjects.set(input.publishedKey, input.bytes);
  }

  readonly publishedObjects = new Map<string, Uint8Array>();

  publicUrl(input: { readonly publishedKey: string }) {
    return `https://charts.example.net/${input.publishedKey}`;
  }

  async deleteStagingObject(input: { readonly stagingKey: string }) {
    this.deletedStaging.push(input.stagingKey);
    this.objects.delete(input.stagingKey);
  }

  async deletePublishedObject(input: { readonly publishedKey: string }) {
    this.deletedPublished.push(input.publishedKey);
  }

  upload(
    stagingKey: string,
    input: ReturnType<typeof chartBytes> = chartBytes(),
  ) {
    this.objects.set(stagingKey, {
      contentType: 'image/png',
      byteSize: input.byteSize,
      bytes: input.bytes,
    });
  }
}

describe('Writing Task 1 chart upload HTTP flow', () => {
  let app: NestFastifyApplication;
  let mockAgent: MockAgent;
  let repository: FakeRepository;
  let storage: FakeStorage;
  let currentTime = new Date('2026-10-14T00:00:00.000Z');
  const oldEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    sandboxHost: process.env.AIHUB_SANDBOX_HOST,
    writingUrl: process.env.DOWNSTREAM_AI_WRITING_URL,
    writingToken: process.env.DOWNSTREAM_AI_WRITING_TOKEN,
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIHUB_SANDBOX_HOST = 'sandbox.test';
    process.env.DOWNSTREAM_AI_WRITING_URL = 'https://ai-writing.test';
    process.env.DOWNSTREAM_AI_WRITING_TOKEN = 'writing-token';
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const authenticator: ApiKeyAuthenticatorPort = {
      authenticate: async ({ environment, value }) => ({
        organizationId: 'org_chart_upload',
        apiKeyId: 'ak_chart_upload',
        environment,
        scopes: value === 'scope-less' ? [] : ['writing.grade'],
        rateLimitRpm: 600,
        maxConcurrent: 20,
        monthlyRequestQuota: null,
        hardStopOnQuota: false,
        allowedEnvironments: [environment],
      }),
    };
    const identities: UserIdentityResolverPort = {
      resolve: async ({ organizationId, value }) => ({
        userId: value,
        organizationId,
        scopes: [],
      }),
    };
    repository = new FakeRepository();
    storage = new FakeStorage();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue(authenticator)
      .overrideProvider(USER_IDENTITY_RESOLVER)
      .useValue(identities)
      .overrideProvider(RATE_LIMITER)
      .useValue({ consume: async () => ({ allowed: true }) })
      .overrideProvider(WRITING_CHART_UPLOAD_REPOSITORY)
      .useValue(repository)
      .overrideProvider(WRITING_CHART_UPLOAD_STORAGE)
      .useValue(storage)
      .overrideProvider(WRITING_CHART_UPLOAD_CLOCK)
      .useValue(() => new Date(currentTime))
      .overrideProvider(DownstreamHttpClient)
      .useValue(new DownstreamHttpClient('https://ai-writing.test', mockAgent))
      .overrideProvider(IDEMPOTENCY_REPOSITORY)
      .useValue(new InMemoryIdempotencyRepository())
      .overrideProvider(DISPATCH_ATTEMPT_RECORD)
      .useValue(noOpDispatchAttemptRecord)
      .overrideProvider(SANDBOX_DISPATCH_BUDGET)
      .useValue({ reserve: async () => true, release: async () => {} })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    registerRequestLifecycle(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    if (oldEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldEnvironment.nodeEnv;
    if (oldEnvironment.sandboxHost === undefined)
      delete process.env.AIHUB_SANDBOX_HOST;
    else process.env.AIHUB_SANDBOX_HOST = oldEnvironment.sandboxHost;
    if (oldEnvironment.writingUrl === undefined)
      delete process.env.DOWNSTREAM_AI_WRITING_URL;
    else process.env.DOWNSTREAM_AI_WRITING_URL = oldEnvironment.writingUrl;
    if (oldEnvironment.writingToken === undefined)
      delete process.env.DOWNSTREAM_AI_WRITING_TOKEN;
    else process.env.DOWNSTREAM_AI_WRITING_TOKEN = oldEnvironment.writingToken;
  });

  beforeEach(() => {
    currentTime = new Date('2026-10-14T00:00:00.000Z');
    repository.rows.clear();
    storage.uploads.length = 0;
    storage.published.length = 0;
    storage.deletedStaging.length = 0;
    storage.objects.clear();
    storage.publishedObjects.clear();
    storage.maxConcurrentInspections = 0;
    storage.inspectionDelayMs = 0;
  });

  const headers = (identity = 'learner-42', key = 'valid-key') => ({
    host: 'sandbox.test',
    'x-api-key': key,
    'x-user-identity': identity,
  });

  it('requires the grading scope and the same User Identity header before creating an intent', async () => {
    const missingKey = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/chart-uploads',
      headers: { host: 'sandbox.test' },
      payload: { content_type: 'image/png', byte_size: chartBytes().byteSize },
    });
    const noScope = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/chart-uploads',
      headers: headers('learner-42', 'scope-less'),
      payload: { content_type: 'image/png', byte_size: chartBytes().byteSize },
    });
    const noIdentity = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/chart-uploads',
      headers: { host: 'sandbox.test', 'x-api-key': 'valid-key' },
      payload: { content_type: 'image/png', byte_size: chartBytes().byteSize },
    });
    expect(missingKey.statusCode).toBe(401);
    expect(noScope.statusCode).toBe(403);
    expect(noIdentity.statusCode).toBe(401);
    expect(repository.rows.size).toBe(0);
    expect(storage.uploads).toEqual([]);
  });

  it('creates, privately uploads, verifies, publishes, and grades using the returned URL', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/chart-uploads',
      headers: headers(),
      payload: { content_type: 'image/png', byte_size: chartBytes().byteSize },
    });
    expect(create.statusCode).toBe(201);
    expect(create.headers['cache-control']).toBe('no-store');
    const grant = create.json().data;
    expect(grant).toMatchObject({
      method: 'POST',
      fields: { 'Content-Type': 'image/png' },
    });
    const intent = repository.rows.get(
      grant.asset_id,
    ) as WritingChartUploadIntent;
    expect(intent).toMatchObject({
      organizationId: 'org_chart_upload',
      endUserId: 'learner-42',
      environment: 'sandbox',
      status: 'open',
    });
    storage.upload(intent.stagingKey);

    const wrongOwner = await app.inject({
      method: 'POST',
      url: `/v1/ielts/writing/task1/chart-uploads/${grant.asset_id}/complete`,
      headers: headers('learner-other'),
    });
    expect(wrongOwner.statusCode).toBe(404);
    expect(storage.published).toEqual([]);

    const complete = await app.inject({
      method: 'POST',
      url: `/v1/ielts/writing/task1/chart-uploads/${grant.asset_id}/complete`,
      headers: headers(),
    });
    expect(complete.statusCode).toBe(200);
    const imageUrl = complete.json().data.image_url as string;
    expect(imageUrl).toBe(`https://charts.example.net/${intent.publishedKey}`);
    expect(complete.json().data.expires_at).toBe('2026-10-15T00:00:00.000Z');
    expect(storage.published).toEqual([intent.publishedKey]);
    expect(storage.publishedObjects.get(intent.publishedKey)).not.toEqual(
      chartBytes().bytes,
    );
    expect(storage.deletedStaging).toEqual([intent.stagingKey]);

    const pool = mockAgent.get('https://ai-writing.test');
    pool
      .intercept({
        method: 'POST',
        path: '/grading-feedback-task1',
        body: JSON.stringify({
          question: task1.question,
          topic: task1.topic,
          essay: task1.essay,
          url: imageUrl,
        }),
        headers: { authorization: 'Bearer writing-token' },
      })
      .reply(200, () =>
        JSON.parse(
          readFileSync(join(FIXTURES, 'grade-task1.response.json'), 'utf8'),
        ),
      );
    const grade = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers: {
        ...headers(),
        'idempotency-key': '00000000-0000-4000-8000-000000000001',
      },
      payload: {
        question: task1.question,
        chart_type: task1.topic,
        essay: task1.essay,
        image_url: imageUrl,
      },
    });
    expect(grade.json()).toMatchObject({ data: { overall_band: 7 } });
  });

  it('rejects bytes that do not match the declared content before publishing', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/chart-uploads',
      headers: headers(),
      payload: { content_type: 'image/png', byte_size: chartBytes().byteSize },
    });
    const assetId = create.json().data.asset_id as string;
    const intent = repository.rows.get(assetId) as WritingChartUploadIntent;
    const invalidImage = new Uint8Array(chartBytes().byteSize).fill(0x20);
    invalidImage.set(new TextEncoder().encode('<html>not an image</html>'));
    storage.upload(intent.stagingKey, {
      bytes: invalidImage,
      byteSize: invalidImage.byteLength,
    });
    const complete = await app.inject({
      method: 'POST',
      url: `/v1/ielts/writing/task1/chart-uploads/${assetId}/complete`,
      headers: headers(),
    });
    expect(complete.statusCode).toBe(400);
    expect(storage.published).toEqual([]);
    expect(storage.deletedStaging).toContain(intent.stagingKey);
    expect(repository.rows.get(assetId)?.status).toBe('rejected');
  });

  it('rejects unsupported and oversized declarations before storing an intent', async () => {
    const unsupported = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/chart-uploads',
      headers: headers(),
      payload: { content_type: 'image/svg+xml', byte_size: 36 },
    });
    const oversized = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/chart-uploads',
      headers: headers(),
      payload: { content_type: 'image/png', byte_size: 10 * 1024 * 1024 + 1 },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(413);
    expect(repository.rows.size).toBe(0);
  });

  it('publishes one asset only when completion is requested concurrently', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/chart-uploads',
      headers: headers(),
      payload: {
        content_type: 'image/png',
        byte_size: chartBytes().byteSize,
      },
    });
    const assetId = create.json().data.asset_id as string;
    const intent = repository.rows.get(assetId) as WritingChartUploadIntent;
    storage.upload(intent.stagingKey);

    const complete = () =>
      app.inject({
        method: 'POST',
        url: `/v1/ielts/writing/task1/chart-uploads/${assetId}/complete`,
        headers: headers(),
      });
    const responses = await Promise.all([complete(), complete()]);

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    expect(responses[0]?.json().data).toEqual(responses[1]?.json().data);
    expect(storage.published).toEqual([intent.publishedKey]);
  });

  it('allows concurrent storage reads while processing images one at a time', async () => {
    storage.inspectionDelayMs = 20;
    const intents = await Promise.all(
      [1, 2].map(async () => {
        const create = await app.inject({
          method: 'POST',
          url: '/v1/ielts/writing/task1/chart-uploads',
          headers: headers(),
          payload: {
            content_type: 'image/png',
            byte_size: chartBytes().byteSize,
          },
        });
        const assetId = create.json().data.asset_id as string;
        const intent = repository.rows.get(assetId) as WritingChartUploadIntent;
        storage.upload(intent.stagingKey);
        return assetId;
      }),
    );

    await Promise.all(
      intents.map((assetId) =>
        app.inject({
          method: 'POST',
          url: `/v1/ielts/writing/task1/chart-uploads/${assetId}/complete`,
          headers: headers(),
        }),
      ),
    );

    expect(storage.maxConcurrentInspections).toBe(2);
    expect(storage.published).toHaveLength(2);
  });
});
