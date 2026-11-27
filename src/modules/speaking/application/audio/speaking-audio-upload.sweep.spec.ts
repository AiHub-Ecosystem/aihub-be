import {
  SPEAKING_AUDIO_ORPHAN_GRACE_MS,
  type SpeakingAudioUploadIntent,
  speakingAudioStagingObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';
import { UploadSessionSweep } from '@/modules/uploads/public';
import {
  SpeakingAudioCoreRepositoryAdapter,
  SpeakingAudioCoreStorageAdapter,
} from './speaking-audio-upload-session.adapters';
import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from './speaking-audio-upload.port';
import {
  DELETION_CEILING,
  SpeakingAudioUploadSweep,
} from './speaking-audio-upload.sweep';

const intent: SpeakingAudioUploadIntent = {
  assetId: 'aud_01J00000000000000000000001',
  organizationId: 'org_test',
  endUserId: 'student-test',
  environment: 'sandbox',
  objectKey: 'orgs/org_test/speaking/aud_01J00000000000000000000001/original',
  contentType: 'audio/wav',
  byteSize: 1_024,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  expiresAt: new Date('2026-10-01T01:00:00.000Z'),
  status: 'open',
};

function pagedCandidates(total: number): SpeakingAudioUploadIntent[][] {
  const candidates: SpeakingAudioUploadIntent[] = Array.from(
    { length: total },
    (_, index) => ({
      ...intent,
      assetId: `aud_01J0000000000000000000${String(index).padStart(5, '0')}`,
    }),
  );
  const pages: SpeakingAudioUploadIntent[][] = [];
  for (let offset = 0; offset < candidates.length; offset += 500) {
    pages.push(candidates.slice(offset, offset + 500));
  }
  return pages;
}

function makeSweep(
  repository: Pick<
    SpeakingAudioUploadRepositoryPort,
    'listCleanupCandidates' | 'removeCleanupCandidate'
  >,
  storage: Pick<SpeakingAudioAssetStoragePort, 'deleteObject'>,
): SpeakingAudioUploadSweep {
  return new SpeakingAudioUploadSweep(
    new UploadSessionSweep(
      new SpeakingAudioCoreRepositoryAdapter(
        repository as SpeakingAudioUploadRepositoryPort,
      ),
      new SpeakingAudioCoreStorageAdapter(
        storage as SpeakingAudioAssetStoragePort,
      ),
      { orphanGraceMs: SPEAKING_AUDIO_ORPHAN_GRACE_MS },
      DELETION_CEILING,
      2,
    ),
  );
}

describe('SpeakingAudioUploadSweep', () => {
  it('deletes staging and final objects before removing an expired intent', async () => {
    const repository = {
      listCleanupCandidates: jest.fn().mockResolvedValue([intent]),
      removeCleanupCandidate: jest.fn().mockResolvedValue(true),
    } satisfies Pick<
      SpeakingAudioUploadRepositoryPort,
      'listCleanupCandidates' | 'removeCleanupCandidate'
    >;
    const storage = {
      deleteObject: jest.fn().mockResolvedValue(undefined),
    } satisfies Pick<SpeakingAudioAssetStoragePort, 'deleteObject'>;
    const sweep = makeSweep(repository, storage);

    await expect(
      sweep.run({ dryRun: false, now: new Date('2026-10-03T00:00:00.000Z') }),
    ).resolves.toMatchObject({
      deleted: 1,
      failed: 0,
      ceilingExceeded: false,
    });
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(storage.deleteObject).toHaveBeenCalledWith({
      environment: 'sandbox',
      objectKey: intent.objectKey,
    });
    expect(storage.deleteObject).toHaveBeenCalledWith({
      environment: 'sandbox',
      objectKey: speakingAudioStagingObjectKey(
        intent.organizationId,
        intent.assetId,
      ),
    });
    expect(repository.removeCleanupCandidate).toHaveBeenCalledWith({
      intent,
      expiredBefore: new Date('2026-10-02T00:00:00.000Z'),
    });
  });

  it('retains the intent when either object deletion fails so the orphan final can be retried', async () => {
    const repository = {
      listCleanupCandidates: jest.fn().mockResolvedValue([intent]),
      removeCleanupCandidate: jest.fn().mockResolvedValue(true),
    } satisfies Pick<
      SpeakingAudioUploadRepositoryPort,
      'listCleanupCandidates' | 'removeCleanupCandidate'
    >;
    const storage = {
      deleteObject: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('staging delete failed')),
    } satisfies Pick<SpeakingAudioAssetStoragePort, 'deleteObject'>;
    const sweep = makeSweep(repository, storage);

    await expect(
      sweep.run({ dryRun: false, now: new Date('2026-10-03T00:00:00.000Z') }),
    ).resolves.toMatchObject({
      deleted: 0,
      failed: 1,
      ceilingExceeded: false,
    });
    expect(repository.removeCleanupCandidate).not.toHaveBeenCalled();
  });

  it.each([
    {
      candidateCount: 1_000,
      expectedDeleted: 1_000,
      expectedObjectDeletes: 2_000,
      ceilingExceeded: false,
    },
    {
      candidateCount: 1_001,
      expectedDeleted: 0,
      expectedObjectDeletes: 0,
      ceilingExceeded: true,
    },
  ])(
    'enforces the 2,000-object-key ceiling across pages ($candidateCount intents)',
    async ({
      candidateCount,
      expectedDeleted,
      expectedObjectDeletes,
      ceilingExceeded,
    }) => {
      const pages = pagedCandidates(candidateCount);
      const repository = {
        listCleanupCandidates: jest.fn(async () => pages.shift() ?? []),
        removeCleanupCandidate: jest.fn().mockResolvedValue(true),
      } satisfies Pick<
        SpeakingAudioUploadRepositoryPort,
        'listCleanupCandidates' | 'removeCleanupCandidate'
      >;
      const storage = { deleteObject: jest.fn().mockResolvedValue(undefined) };
      const sweep = makeSweep(repository, storage);

      await expect(
        sweep.run({
          dryRun: false,
          now: new Date('2026-10-03T00:00:00.000Z'),
        }),
      ).resolves.toMatchObject({
        eligible: candidateCount,
        deleted: expectedDeleted,
        failed: 0,
        ceilingExceeded,
      });
      expect(repository.listCleanupCandidates).toHaveBeenCalledTimes(3);
      expect(storage.deleteObject).toHaveBeenCalledTimes(expectedObjectDeletes);
      expect(repository.removeCleanupCandidate).toHaveBeenCalledTimes(
        expectedDeleted,
      );
    },
  );
});
