import type {
  WritingChartCleanupCandidate,
  WritingChartUploadRepositoryPort,
  WritingChartUploadStoragePort,
} from './writing-chart-upload.port';
import { WritingChartUploadSweep } from './writing-chart-upload.sweep';

const candidates: WritingChartCleanupCandidate[] = [
  {
    kind: 'intent',
    assetId: 'chart_01J00000000000000000000001',
    environment: 'sandbox',
    stagingKey: 'writing-charts/chart_01J00000000000000000000001/staging',
    publishedKey: 'writing-charts/chart_01J00000000000000000000001/published',
    createdAt: new Date('2026-10-14T00:00:00.000Z'),
  },
  {
    kind: 'asset',
    assetId: 'chart_01J00000000000000000000002',
    environment: 'production',
    stagingKey: 'writing-charts/chart_01J00000000000000000000002/staging',
    publishedKey: 'writing-charts/chart_01J00000000000000000000002/published',
    createdAt: new Date('2026-10-14T00:01:00.000Z'),
  },
];

function makeSweep() {
  const repository = {
    cleanupCandidates: jest.fn().mockResolvedValue(candidates),
    removeCleanupCandidate: jest.fn().mockResolvedValue(true),
  } satisfies Pick<
    WritingChartUploadRepositoryPort,
    'cleanupCandidates' | 'removeCleanupCandidate'
  >;
  const storage = {
    deleteStagingObject: jest.fn().mockResolvedValue(undefined),
    deletePublishedObject: jest.fn().mockResolvedValue(undefined),
  } satisfies Pick<
    WritingChartUploadStoragePort,
    'deleteStagingObject' | 'deletePublishedObject'
  >;
  return {
    sweep: new WritingChartUploadSweep(repository, storage),
    repository,
    storage,
  };
}

describe('WritingChartUploadSweep', () => {
  it('deletes staging and published bytes before removing durable rows', async () => {
    const { sweep, repository, storage } = makeSweep();

    const summary = await sweep.run({
      dryRun: false,
      now: new Date('2026-10-16T00:00:00.000Z'),
    });

    expect(summary).toEqual({
      scanned: 2,
      eligible: 2,
      deleted: 2,
      failed: 0,
      dryRun: false,
    });
    expect(storage.deleteStagingObject).toHaveBeenCalledTimes(2);
    expect(storage.deletePublishedObject).toHaveBeenCalledTimes(2);
    expect(repository.removeCleanupCandidate).toHaveBeenCalledTimes(2);
    expect(repository.cleanupCandidates).toHaveBeenCalledWith({
      now: new Date('2026-10-16T00:00:00.000Z'),
      orphanBefore: new Date('2026-10-15T00:00:00.000Z'),
      limit: 500,
    });
  });

  it('deletes the published object of an expired upload that never said published', async () => {
    // A publishing row past its expiry, or one returned to open after a
    // publication the store accepted but reported as failed (#921).
    const { sweep, repository, storage } = makeSweep();
    repository.cleanupCandidates.mockResolvedValue([candidates[0]]);

    await sweep.run({
      dryRun: false,
      now: new Date('2026-10-16T00:00:00.000Z'),
    });

    expect(storage.deleteStagingObject).toHaveBeenCalledWith({
      environment: 'sandbox',
      stagingKey: candidates[0]?.stagingKey,
    });
    expect(storage.deletePublishedObject).toHaveBeenCalledWith({
      environment: 'sandbox',
      publishedKey: candidates[0]?.publishedKey,
    });
    expect(repository.removeCleanupCandidate).toHaveBeenCalledWith(
      candidates[0],
    );
  });

  it('retains the durable row when either object deletion fails', async () => {
    const { sweep, repository, storage } = makeSweep();
    repository.cleanupCandidates.mockResolvedValue(candidates);
    storage.deleteStagingObject
      .mockRejectedValueOnce(new Error('staging storage down'))
      .mockResolvedValueOnce(undefined);
    storage.deletePublishedObject
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('published storage down'));

    const summary = await sweep.run({
      dryRun: false,
      now: new Date('2026-10-16T00:00:00.000Z'),
    });

    expect(summary.deleted).toBe(0);
    expect(summary.failed).toBe(2);
    expect(storage.deleteStagingObject).toHaveBeenCalledTimes(2);
    expect(storage.deletePublishedObject).toHaveBeenCalledTimes(2);
    expect(repository.removeCleanupCandidate).not.toHaveBeenCalled();
  });

  it('follows the keyset cursor across cleanup batches', async () => {
    const { sweep, repository, storage } = makeSweep();
    const paginatedCandidates = Array.from({ length: 501 }, (_, index) => ({
      kind: 'asset' as const,
      assetId: `chart_${String(index).padStart(26, '0')}`,
      environment: 'sandbox' as const,
      stagingKey: `writing-charts/${index}/staging`,
      publishedKey: `writing-charts/${index}/published`,
      createdAt: new Date('2026-10-14T00:00:00.000Z'),
    }));
    repository.cleanupCandidates.mockImplementation(
      async (
        input: Parameters<
          WritingChartUploadRepositoryPort['cleanupCandidates']
        >[0],
      ) => {
        const cursorIndex = paginatedCandidates.findIndex(
          (candidate) => candidate.assetId === input.after?.assetId,
        );
        return paginatedCandidates.slice(
          cursorIndex + 1,
          cursorIndex + 1 + input.limit,
        );
      },
    );

    const summary = await sweep.run({
      dryRun: true,
      now: new Date('2026-10-16T00:00:00.000Z'),
    });

    expect(summary).toEqual({
      scanned: 501,
      eligible: 501,
      deleted: 0,
      failed: 0,
      dryRun: true,
    });
    expect(repository.cleanupCandidates).toHaveBeenCalledTimes(2);
    expect(repository.cleanupCandidates).toHaveBeenNthCalledWith(2, {
      now: new Date('2026-10-16T00:00:00.000Z'),
      orphanBefore: new Date('2026-10-15T00:00:00.000Z'),
      limit: 500,
      after: {
        createdAt: paginatedCandidates[499]?.createdAt,
        assetId: paginatedCandidates[499]?.assetId,
      },
    });
    expect(storage.deleteStagingObject).not.toHaveBeenCalled();
    expect(storage.deletePublishedObject).not.toHaveBeenCalled();
    expect(repository.removeCleanupCandidate).not.toHaveBeenCalled();
  });

  it('reports eligible objects without deleting them during a dry run', async () => {
    const { sweep, repository, storage } = makeSweep();

    const summary = await sweep.run({
      dryRun: true,
      now: new Date('2026-10-16T00:00:00.000Z'),
    });

    expect(summary).toMatchObject({ eligible: 2, deleted: 0, dryRun: true });
    expect(storage.deleteStagingObject).not.toHaveBeenCalled();
    expect(repository.removeCleanupCandidate).not.toHaveBeenCalled();
  });
});
