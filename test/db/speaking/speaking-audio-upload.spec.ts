import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { SpeakingAudioAssetStoragePort } from '@/modules/speaking/application/speaking-audio-upload.port';
import { SpeakingAudioUploadService } from '@/modules/speaking/application/speaking-audio-upload.service';
import {
  type SpeakingAudioAsset,
  type SpeakingAudioUploadIntent,
  speakingAudioObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';
import {
  PostgresSpeakingAudioUploadRepository,
  createSpeakingAudioQueryClient,
} from '@/modules/speaking/infrastructure/postgres-speaking-audio-upload.repository';

import {
  createSandboxTestPool,
  createTestPool,
  resetIdentityTables,
} from '../shared/database';

let pool: Pool;
let sandboxPool: Pool;
let repository: PostgresSpeakingAudioUploadRepository;
let sandboxRepository: PostgresSpeakingAudioUploadRepository;
let closeRepository: () => Promise<void>;
let closeSandboxRepository: () => Promise<void>;
let organizationId: string;
let otherOrganizationId: string;

const storage: SpeakingAudioAssetStoragePort = {
  createUploadUrl: async () => ({
    url: 'https://example.test/upload',
    expiresAt: new Date('2026-10-03T04:30:00.000Z'),
  }),

  describeObject: async () => undefined,
  copyObject: async () => undefined,
  deleteObject: async () => undefined,
};

beforeAll(() => {
  pool = createTestPool();
  const databaseUrl =
    (pool.options as { connectionString?: string }).connectionString ?? '';
  const client = createSpeakingAudioQueryClient(databaseUrl);
  repository = new PostgresSpeakingAudioUploadRepository(client);
  closeRepository = () => client.close();

  sandboxPool = createSandboxTestPool();
  const sandboxDatabaseUrl =
    (sandboxPool.options as { connectionString?: string }).connectionString ??
    '';
  const sandboxClient = createSpeakingAudioQueryClient(sandboxDatabaseUrl);
  sandboxRepository = new PostgresSpeakingAudioUploadRepository(sandboxClient);
  closeSandboxRepository = () => sandboxClient.close();
});

afterAll(async () => {
  await closeRepository();
  await closeSandboxRepository();
  await pool.end();
  await sandboxPool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
  organizationId = `org_${ulid()}`;
  await pool.query(
    `INSERT INTO organizations (id, name, status)
     VALUES ($1, $2, 'active')`,
    [organizationId, `Speaking audio ${organizationId}`],
  );
  otherOrganizationId = `org_${ulid()}`;
  await pool.query(
    `INSERT INTO organizations (id, name, status)
     VALUES ($1, $2, 'active')`,
    [otherOrganizationId, `Speaking audio ${otherOrganizationId}`],
  );
});

function context(ownerOrganizationId: string) {
  return createRequestContext({
    requestId: `req_${ulid()}`,
    receivedAt: new Date('2026-10-03T04:10:00.000Z'),
    deadlineMs: 10_000,
    organizationId: ownerOrganizationId,
    environment: 'production',
    userId: 'student-123',
    scopes: ['speaking:grade'],
  });
}

function intent(
  assetId = `aud_${ulid()}`,
  ownerOrganizationId = organizationId,
  environment: 'production' | 'sandbox' = 'production',
): SpeakingAudioUploadIntent {
  const createdAt = new Date('2026-10-03T04:00:00.000Z');
  return {
    assetId,
    organizationId: ownerOrganizationId,
    endUserId: 'student-123',
    environment,
    objectKey: speakingAudioObjectKey(ownerOrganizationId, assetId),
    contentType: 'audio/wav',
    byteSize: 1_024,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 60 * 60 * 1_000),
    status: 'open',
  };
}

function asset(upload: SpeakingAudioUploadIntent): SpeakingAudioAsset {
  const acceptedAt = new Date('2026-10-03T04:05:00.000Z');
  return {
    assetId: upload.assetId,
    organizationId: upload.organizationId,
    endUserId: upload.endUserId,
    environment: upload.environment,
    objectKey: upload.objectKey,
    contentType: upload.contentType,
    byteSize: upload.byteSize,
    acceptedAt,
    retentionExpiresAt: new Date(
      acceptedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
    ),
  };
}

describe('Speaking Audio upload completion against PostgreSQL', () => {
  it('holds the intent row lock across preparation and atomically accepts one completion', async () => {
    const upload = intent();
    await repository.createIntent(upload);
    let releasePreparation = () => {};
    const preparationBarrier = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let announcePreparation = () => {};
    const preparationStarted = new Promise<void>((resolve) => {
      announcePreparation = resolve;
    });
    const prepare = jest.fn(async (lockedIntent: SpeakingAudioUploadIntent) => {
      announcePreparation();
      await preparationBarrier;
      return { kind: 'accepted' as const, asset: asset(lockedIntent) };
    });
    const input = {
      owner: {
        assetId: upload.assetId,
        organizationId: upload.organizationId,
        endUserId: upload.endUserId,
        environment: upload.environment,
      },
      now: () => new Date('2026-10-03T04:05:00.000Z'),
      prepare,
    };

    let announceSecondCall = () => {};
    const secondCallStarted = new Promise<void>((resolve) => {
      announceSecondCall = resolve;
    });
    const originalCompleteIntent = repository.completeIntent.bind(repository);
    let calls = 0;
    const completeIntent = jest
      .spyOn(repository, 'completeIntent')
      .mockImplementation((completion) => {
        calls += 1;
        if (calls === 2) announceSecondCall();
        return originalCompleteIntent(completion);
      });
    let results: Awaited<ReturnType<typeof originalCompleteIntent>>[] = [];
    try {
      const first = repository.completeIntent(input);
      await preparationStarted;
      const second = repository.completeIntent(input);
      await secondCallStarted;
      releasePreparation();
      results = await Promise.all([first, second]);
    } finally {
      completeIntent.mockRestore();
    }

    expect(results.map((result) => result.kind).sort()).toEqual([
      'already_completed',
      'created',
    ]);
    const created = results.find((result) => result.kind === 'created');
    const alreadyCompleted = results.find(
      (result) => result.kind === 'already_completed',
    );
    expect(alreadyCompleted?.asset).toEqual(created?.asset);
    expect(prepare).toHaveBeenCalledTimes(1);
    const rows = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM speaking_audio_upload_intents WHERE id = $1) AS intents,
         (SELECT count(*)::int FROM speaking_audio_assets WHERE id = $1) AS assets`,
      [upload.assetId],
    );
    expect(rows.rows[0]).toEqual({ intents: 0, assets: 1 });
  });

  it('rolls back asset creation if the intent cannot be consumed', async () => {
    const upload = intent();
    const otherOrganizationId = `org_${ulid()}`;
    await pool.query(
      `INSERT INTO organizations (id, name, status)
       VALUES ($1, $2, 'active')`,
      [otherOrganizationId, `Other ${otherOrganizationId}`],
    );
    await repository.createIntent(upload);
    const conflictingAsset = {
      ...asset(upload),
      organizationId: otherOrganizationId,
      endUserId: 'another-student',
      objectKey: speakingAudioObjectKey(otherOrganizationId, upload.assetId),
    };
    await pool.query(
      `INSERT INTO speaking_audio_assets
         (id, organization_id, end_user_id, environment, object_key,
          content_type, byte_size, accepted_at, retention_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        conflictingAsset.assetId,
        conflictingAsset.organizationId,
        conflictingAsset.endUserId,
        conflictingAsset.environment,
        conflictingAsset.objectKey,
        conflictingAsset.contentType,
        conflictingAsset.byteSize,
        conflictingAsset.acceptedAt,
        conflictingAsset.retentionExpiresAt,
      ],
    );

    await expect(
      repository.completeIntent({
        owner: {
          assetId: upload.assetId,
          organizationId: upload.organizationId,
          endUserId: upload.endUserId,
          environment: upload.environment,
        },
        now: () => new Date('2026-10-03T04:05:00.000Z'),
        prepare: async (lockedIntent) => ({
          kind: 'accepted',
          asset: asset(lockedIntent),
        }),
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    const rows = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM speaking_audio_upload_intents WHERE id = $1) AS intents,
         (SELECT count(*)::int FROM speaking_audio_assets WHERE id = $1) AS assets`,
      [upload.assetId],
    );
    expect(rows.rows[0]).toEqual({ intents: 1, assets: 1 });
  });

  it('answers not-found for another Organization using the same End-User ID', async () => {
    const upload = intent();
    await repository.createIntent(upload);
    const service = new SpeakingAudioUploadService(
      repository,
      storage,
      () => `aud_${ulid()}`,
      () => new Date('2026-10-03T04:10:00.000Z'),
    );

    // The control: the same call succeeds for the Organization that owns it.
    await expect(
      service.refreshUpload({
        context: context(organizationId),
        assetId: upload.assetId,
      }),
    ).resolves.toBeDefined();
    await expect(
      service.refreshUpload({
        context: context(otherOrganizationId),
        assetId: upload.assetId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      repository.completeIntent({
        owner: {
          assetId: upload.assetId,
          organizationId: upload.organizationId,
          endUserId: upload.endUserId,
          environment: upload.environment,
        },
        now: () => new Date('2026-10-03T04:05:00.000Z'),
        prepare: async (lockedIntent) => ({
          kind: 'accepted',
          asset: asset(lockedIntent),
        }),
      }),
    ).resolves.toMatchObject({ kind: 'created' });
    await expect(
      service.completeUpload({
        context: context(otherOrganizationId),
        assetId: upload.assetId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stores Sandbox uploads when the Organization exists only in the control plane', async () => {
    const sandboxOrganizationId = `org_${ulid()}`;
    const upload = intent(`aud_${ulid()}`, sandboxOrganizationId, 'sandbox');
    const localOrganizations = await sandboxPool.query(
      'SELECT count(*)::int AS count FROM organizations WHERE id = $1',
      [sandboxOrganizationId],
    );
    expect(localOrganizations.rows[0]).toEqual({ count: 0 });

    await sandboxRepository.createIntent(upload);
    const result = await sandboxRepository.completeIntent({
      owner: {
        assetId: upload.assetId,
        organizationId: upload.organizationId,
        endUserId: upload.endUserId,
        environment: upload.environment,
      },
      now: () => new Date('2026-10-03T04:05:00.000Z'),
      prepare: async (lockedIntent) => ({
        kind: 'accepted',
        asset: asset(lockedIntent),
      }),
    });

    expect(result.kind).toBe('created');
    const rows = await sandboxPool.query(
      `SELECT
         (SELECT count(*)::int FROM organizations WHERE id = $1) AS organizations,
         (SELECT count(*)::int FROM speaking_audio_upload_intents WHERE id = $2) AS intents,
         (SELECT count(*)::int FROM speaking_audio_assets WHERE id = $2) AS assets`,
      [sandboxOrganizationId, upload.assetId],
    );
    expect(rows.rows[0]).toEqual({ organizations: 0, intents: 0, assets: 1 });
  });
});
