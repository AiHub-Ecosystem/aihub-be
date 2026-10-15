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
    expect(storage.deletePublishedObject).toHaveBeenCalledTimes(1);
    expect(repository.removeCleanupCandidate).toHaveBeenCalledTimes(2);
  });

  it('retains the durable row when either object deletion fails', async () => {
    const { sweep, repository, storage } = makeSweep();
    storage.deletePublishedObject.mockRejectedValue(new Error('storage down'));

    const summary = await sweep.run({
      dryRun: false,
      now: new Date('2026-10-16T00:00:00.000Z'),
    });

    expect(summary.deleted).toBe(1);
    expect(summary.failed).toBe(1);
    expect(repository.removeCleanupCandidate).toHaveBeenCalledTimes(1);
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
