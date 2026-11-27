import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import {
  SpeakingAudioCoreRepositoryAdapter,
  SpeakingAudioCoreStorageAdapter,
} from '@/modules/speaking/application/audio/speaking-audio-upload-session.adapters';
import { speakingAudioUploadSessionPolicy } from '@/modules/speaking/application/audio/speaking-audio-upload-session.policy';
import type { SpeakingAudioAssetStoragePort } from '@/modules/speaking/application/audio/speaking-audio-upload.port';
import { SpeakingAudioUploadService } from '@/modules/speaking/application/audio/speaking-audio-upload.service';
import {
  type SpeakingAudioAsset,
  type SpeakingAudioUploadIntent,
  speakingAudioObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';
import { PostgresSpeakingAudioUploadRepository } from '@/modules/speaking/infrastructure/postgres-speaking-audio-upload.repository';
import {
  UploadSessionService,
  UploadSessionSweep,
} from '@/modules/uploads/public';

import { createSpeakingAudioQueryClient } from '../shared/postgres-speaking-audio-upload.fixture-client';

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
  readObject: async () => {
    throw new Error('not used by upload repository tests');
  },
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
  await pool.query(
    'UPDATE speaking_audio_publication_protocol SET activated_at = NULL WHERE id = true',
  );
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

function publicationIntent(): SpeakingAudioUploadIntent {
  const createdAt = new Date(Date.now() - 1_000);
  return {
    ...intent(),
    createdAt,
    expiresAt: new Date(Date.now() + 60_000),
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

describe('Speaking Audio upload intent ceilings against PostgreSQL', () => {
  it('creates a permitted intent while holding the Organization lock', async () => {
    const upload = intent(`aud_${ulid()}`, organizationId, 'sandbox');
    try {
      await expect(
        sandboxRepository.createIntentWithinCeiling({
          intent: upload,
          decide: () => ({ kind: 'within' }),
        }),
      ).resolves.toEqual({ kind: 'within' });

      const rows = await sandboxPool.query(
        'SELECT count(*)::int AS count FROM speaking_audio_upload_intents WHERE id = $1',
        [upload.assetId],
      );
      expect(rows.rows[0]).toEqual({ count: 1 });
    } finally {
      await sandboxPool.query(
        'DELETE FROM speaking_audio_upload_intents WHERE id = $1',
        [upload.assetId],
      );
    }
  });
});

describe('Speaking Audio upload completion against PostgreSQL', () => {
  it('lets another core instance finalize the committed publication reservation', async () => {
    const upload = publicationIntent();
    const owner = {
      assetId: upload.assetId,
      organizationId: upload.organizationId,
      endUserId: upload.endUserId,
      environment: upload.environment,
    };
    const startedAt = new Date();
    await repository.createIntent(upload);
    await pool.query(
      'UPDATE speaking_audio_publication_protocol SET activated_at = clock_timestamp() WHERE id = true',
    );

    const databaseUrl =
      (pool.options as { connectionString?: string }).connectionString ?? '';
    const secondClient = createSpeakingAudioQueryClient(databaseUrl);
    const firstCore = new SpeakingAudioCoreRepositoryAdapter(repository);
    const secondCore = new SpeakingAudioCoreRepositoryAdapter(
      new PostgresSpeakingAudioUploadRepository(secondClient),
    );
    try {
      const reservation = await firstCore.beginPublication({
        owner,
        now: startedAt,
      });
      if (typeof reservation !== 'object') {
        throw new Error('expected a durable publication reservation');
      }
      expect(reservation.kind).toBe('started');
      expect(reservation.publishedKey).toContain('/publication/pub_');
      await expect(
        secondCore.beginPublication({ owner, now: startedAt }),
      ).resolves.toBe('in_progress');

      await expect(
        secondCore.markPublished({
          owner,
          now: startedAt,
          publicationStartedAt: startedAt,
          imageUrl: '',
          reservationId: reservation.reservationId,
        }),
      ).resolves.toMatchObject({
        assetId: upload.assetId,
        publishedKey: reservation.publishedKey,
      });
    } finally {
      await secondClient.close();
    }

    const stored = await repository.findUpload(owner);
    expect(stored.kind).toBe('asset');
  });

  it('uses one copy during overlap and keeps the recorded keys readable on bridge rollback', async () => {
    const legacy = publicationIntent();
    const coordinated = publicationIntent();
    await repository.createIntent(legacy);
    await repository.createIntent(coordinated);
    const url =
      (pool.options as { connectionString?: string }).connectionString ?? '';
    const nextClient = createSpeakingAudioQueryClient(url);
    const nextRepository = new PostgresSpeakingAudioUploadRepository(
      nextClient,
    );
    const copying = Promise.withResolvers<void>();
    const contenderWaiting = Promise.withResolvers<void>();
    const allowCopy = Promise.withResolvers<void>();
    const copyObject = jest.fn(
      async ({
        destinationObjectKey,
      }: Parameters<SpeakingAudioAssetStoragePort['copyObject']>[0]) => {
        if (destinationObjectKey === legacy.objectKey) return;
        copying.resolve();
        await allowCopy.promise;
      },
    );
    const makeCore = (repo: PostgresSpeakingAudioUploadRepository) =>
      new UploadSessionService(
        new SpeakingAudioCoreRepositoryAdapter(repo),
        new SpeakingAudioCoreStorageAdapter({
          ...storage,
          copyObject,
          describeObject: async () => ({
            contentType: 'audio/wav',
            byteSize: 1_024,
          }),
        }),
        speakingAudioUploadSessionPolicy(),
        () => 'unused',
      );
    const bridge = makeCore(repository);
    const next = makeCore(nextRepository);
    const begin = repository.beginPublication.bind(repository);
    const trackedBegin = jest
      .spyOn(repository, 'beginPublication')
      .mockImplementation(async (input) => {
        const result = await begin(input);
        if (result === 'in_progress') contenderWaiting.resolve();
        return result;
      });
    const complete = {
      context: context(organizationId),
      assetId: coordinated.assetId,
    };
    try {
      await expect(
        bridge.complete({ ...complete, assetId: legacy.assetId }),
      ).resolves.toMatchObject({ publishedKey: legacy.objectKey });
      await pool.query(
        'UPDATE speaking_audio_publication_protocol SET activated_at = clock_timestamp() WHERE id = true',
      );
      const publication = next.complete(complete);
      await Promise.race([copying.promise, publication]);
      const contender = bridge.complete(complete);
      await Promise.race([contenderWaiting.promise, contender]);
      allowCopy.resolve();
      const [winner, duplicate] = await Promise.all([publication, contender]);
      expect(winner.publishedKey).toContain('/publication/pub_');
      expect(duplicate.publishedKey).toBe(winner.publishedKey);
      await expect(bridge.complete(complete)).resolves.toMatchObject({
        publishedKey: winner.publishedKey,
      });
      expect(copyObject).toHaveBeenCalledTimes(2);
    } finally {
      allowCopy.resolve();
      trackedBegin.mockRestore();
      await nextClient.close();
    }
  });

  it('keeps a later publication intact when an expired copy finishes late', async () => {
    const upload = publicationIntent();
    const owner = {
      assetId: upload.assetId,
      organizationId: upload.organizationId,
      endUserId: upload.endUserId,
      environment: upload.environment,
    };
    await repository.createIntent(upload);
    await pool.query(
      'UPDATE speaking_audio_publication_protocol SET activated_at = clock_timestamp() WHERE id = true',
    );

    const first = await repository.beginPublication({
      owner,
      now: new Date(),
      reservationTtlMs: 60_000,
    });
    if (typeof first === 'string')
      throw new Error('expected the first publication reservation');
    await pool.query(
      `UPDATE speaking_audio_publication_reservations
       SET created_at = clock_timestamp() - interval '2 seconds',
           expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [first.reservationId],
    );

    const second = await repository.beginPublication({
      owner,
      now: new Date(),
      reservationTtlMs: 60_000,
    });
    if (typeof second === 'string')
      throw new Error('expected the replacement publication reservation');
    await expect(
      repository.claimRefusal(owner, first.reservationId),
    ).resolves.toBe(false);
    await expect(repository.claimRefusal(owner)).resolves.toBe(false);

    const storedBytes = new Map<string, string>();
    storedBytes.set(second.objectKey, 'bytes from B');
    const acceptedAt = new Date();
    const published = await repository.finalizePublication({
      owner,
      reservationId: second.reservationId,
      acceptedAt,
      retentionExpiresAt: new Date(acceptedAt.getTime() + 30 * 86_400_000),
    });
    expect(published).toMatchObject({
      created: true,
      asset: { objectKey: second.objectKey },
    });

    storedBytes.set(first.objectKey, 'late bytes from A');
    const lateFinalization = await repository.finalizePublication({
      owner,
      reservationId: first.reservationId,
      acceptedAt: new Date(),
      retentionExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    expect(lateFinalization).toMatchObject({
      created: false,
      asset: { objectKey: second.objectKey },
    });
    expect(storedBytes.get(second.objectKey)).toBe('bytes from B');

    const cutoff = new Date(Date.now() + 1_000);
    const firstPass = await repository.listDurableCleanupCandidates({
      expiredBefore: cutoff,
      limit: 10,
    });
    const staleCandidate = firstPass.find(
      (candidate) => candidate.reservationId === first.reservationId,
    );
    expect(staleCandidate).toBeDefined();
    if (staleCandidate === undefined)
      throw new Error('expected the expired publication to be cleanable');

    const firstClaim = `cleanup_${ulid()}`;
    await expect(
      repository.claimDurableCleanupCandidate({
        candidate: staleCandidate,
        orphanBefore: cutoff,
        claimId: firstClaim,
        leaseMs: 60_000,
      }),
    ).resolves.toBe(true);
    storedBytes.delete(staleCandidate.objectKey);
    await expect(
      repository.removeDurableCleanupCandidate({
        candidate: staleCandidate,
        expiredBefore: cutoff,
        claimId: firstClaim,
      }),
    ).resolves.toBe(true);

    storedBytes.set(first.objectKey, 'copy completed after first cleanup');
    await pool.query(
      `UPDATE speaking_audio_publication_reservations
       SET last_cleaned_at = clock_timestamp() - interval '25 hours'
       WHERE id = $1`,
      [first.reservationId],
    );
    const secondPass = await repository.listDurableCleanupCandidates({
      expiredBefore: new Date(),
      limit: 10,
    });
    const lateCandidate = secondPass.find(
      (candidate) => candidate.reservationId === first.reservationId,
    );
    expect(lateCandidate).toBeDefined();
    if (lateCandidate === undefined)
      throw new Error('expected the retained reservation tombstone');

    const secondClaim = `cleanup_${ulid()}`;
    await expect(
      repository.claimDurableCleanupCandidate({
        candidate: lateCandidate,
        orphanBefore: new Date(),
        claimId: secondClaim,
        leaseMs: 60_000,
      }),
    ).resolves.toBe(true);
    storedBytes.delete(lateCandidate.objectKey);
    await expect(
      repository.removeDurableCleanupCandidate({
        candidate: lateCandidate,
        expiredBefore: new Date(),
        claimId: secondClaim,
      }),
    ).resolves.toBe(true);

    const winner = await repository.findUpload(owner);
    expect(winner).toMatchObject({
      kind: 'asset',
      asset: { objectKey: second.objectKey },
    });
    expect(storedBytes.get(second.objectKey)).toBe('bytes from B');
  });

  it('lets another core instance remove a cleanup candidate selected earlier', async () => {
    const upload = intent();
    await repository.createIntent(upload);
    await pool.query(
      `UPDATE speaking_audio_upload_intents
       SET created_at = $2, expires_at = $3
       WHERE id = $1`,
      [
        upload.assetId,
        new Date('2026-09-30T00:00:00.000Z'),
        new Date('2026-10-01T00:00:00.000Z'),
      ],
    );

    const databaseUrl =
      (pool.options as { connectionString?: string }).connectionString ?? '';
    const secondClient = createSpeakingAudioQueryClient(databaseUrl);
    const firstCore = new SpeakingAudioCoreRepositoryAdapter(repository);
    const secondCore = new SpeakingAudioCoreRepositoryAdapter(
      new PostgresSpeakingAudioUploadRepository(secondClient),
    );
    try {
      const [candidate] = await firstCore.cleanupCandidates({
        now: new Date('2026-10-03T04:00:00.000Z'),
        orphanBefore: new Date('2026-10-02T00:00:00.000Z'),
        limit: 1,
      });
      expect(candidate).toMatchObject({
        assetId: upload.assetId,
        orphanBefore: new Date('2026-10-02T00:00:00.000Z'),
      });
      if (candidate === undefined)
        throw new Error('expected a cleanup candidate');

      const claim = await secondCore.claimCleanupCandidate(
        candidate,
        new Date(),
      );
      expect(claim).toBeDefined();
      if (claim === undefined)
        throw new Error('expected the second instance to claim cleanup');
      await expect(
        firstCore.claimCleanupCandidate(candidate, new Date()),
      ).resolves.toBeUndefined();
      await pool.query(
        `UPDATE speaking_audio_upload_intents
         SET cleanup_claim_expires_at = clock_timestamp() - interval '1 second'
         WHERE id = $1`,
        [upload.assetId],
      );
      await expect(secondCore.removeCleanupCandidate(claim)).resolves.toBe(
        false,
      );
      const sweep = new UploadSessionSweep(
        firstCore,
        new SpeakingAudioCoreStorageAdapter(storage),
        { orphanGraceMs: 0 },
      );
      await expect(
        sweep.run({
          now: candidate.orphanBefore ?? new Date(),
          dryRun: false,
        }),
      ).resolves.toMatchObject({ deleted: 1, failed: 0 });
    } finally {
      await secondClient.close();
    }

    await expect(
      repository.findUpload({
        assetId: upload.assetId,
        organizationId: upload.organizationId,
        endUserId: upload.endUserId,
        environment: upload.environment,
      }),
    ).resolves.toEqual({ kind: 'missing' });
  });

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
    const policy = speakingAudioUploadSessionPolicy();
    const service = new SpeakingAudioUploadService(
      new UploadSessionService(
        new SpeakingAudioCoreRepositoryAdapter(
          repository,
          () => new Date('2026-10-03T04:10:00.000Z'),
        ),
        new SpeakingAudioCoreStorageAdapter(storage),
        policy,
        () => `aud_${ulid()}`,
        () => new Date('2026-10-03T04:10:00.000Z'),
      ),
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
