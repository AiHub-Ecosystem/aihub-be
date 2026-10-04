import type { Pool } from 'pg';
import { ulid } from 'ulid';

import type {
  SpeakingAudioAsset,
  SpeakingAudioUploadIntent,
} from '@/modules/speaking/domain/speaking-audio-asset';
import { speakingAudioObjectKey } from '@/modules/speaking/domain/speaking-audio-asset';
import {
  PostgresSpeakingAudioUploadRepository,
  createSpeakingAudioQueryClient,
} from '@/modules/speaking/infrastructure/postgres-speaking-audio-upload.repository';

import {
  createSandboxTestPool,
  createTestPool,
  resetIdentityTables,
} from './database';

let pool: Pool;
let sandboxPool: Pool;
let repository: PostgresSpeakingAudioUploadRepository;
let sandboxRepository: PostgresSpeakingAudioUploadRepository;
let closeRepository: () => Promise<void>;
let closeSandboxRepository: () => Promise<void>;
let organizationId: string;

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
});

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
  it('atomically consumes one intent under concurrent completion retries', async () => {
    const upload = intent();
    await repository.createIntent(upload);
    const input = {
      owner: {
        assetId: upload.assetId,
        organizationId: upload.organizationId,
        endUserId: upload.endUserId,
        environment: upload.environment,
      },
      now: new Date('2026-10-03T04:05:00.000Z'),
      asset: asset(upload),
    };

    const results = await Promise.all([
      repository.completeIntent(input),
      repository.completeIntent(input),
    ]);

    expect(results.sort()).toEqual(['already_completed', 'created']);
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
        now: new Date('2026-10-03T04:05:00.000Z'),
        asset: asset(upload),
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
      now: new Date('2026-10-03T04:05:00.000Z'),
      asset: asset(upload),
    });

    expect(result).toBe('created');
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
