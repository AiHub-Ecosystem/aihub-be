import type { SpeakingAudioUploadIntent } from '@/modules/speaking/domain/speaking-audio-asset';
import { speakingAudioStagingObjectKey } from '@/modules/speaking/domain/speaking-audio-asset';
import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from './speaking-audio-upload.port';
import { SpeakingAudioUploadSweep } from './speaking-audio-upload.sweep';

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
    const sweep = new SpeakingAudioUploadSweep(repository, storage);

    await expect(
      sweep.run({ dryRun: false, now: new Date('2026-10-03T00:00:00.000Z') }),
    ).resolves.toMatchObject({ deleted: 1, failed: 0 });
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
    const sweep = new SpeakingAudioUploadSweep(repository, storage);

    await expect(
      sweep.run({ dryRun: false, now: new Date('2026-10-03T00:00:00.000Z') }),
    ).resolves.toMatchObject({ deleted: 0, failed: 1 });
    expect(repository.removeCleanupCandidate).not.toHaveBeenCalled();
  });
});
