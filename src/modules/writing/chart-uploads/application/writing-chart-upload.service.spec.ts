import { reserveWritingChartRasterImageProcessing } from './writing-chart-upload.policy';
import type {
  WritingChartUploadRepositoryPort,
  WritingChartUploadStoragePort,
} from './writing-chart-upload.port';
import { WritingChartUploadService } from './writing-chart-upload.service';

const NOW = new Date('2026-11-17T00:00:00.000Z');
const ASSET = 'chart_01J00000000000000000000001';
const intent = {
  assetId: ASSET,
  organizationId: 'org_01J00000000000000000000000',
  endUserId: 'usr_01J00000000000000000000000',
  environment: 'production',
  stagingKey: `writing-charts/${ASSET}/staging`,
  publishedKey: `writing-charts/${ASSET}/published`,
  contentType: 'image/png',
  byteSize: 12,
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + 60_000),
  status: 'open',
} as const;

function setup() {
  const repository: WritingChartUploadRepositoryPort = {
    createIntent: async () => false,
    findUpload: async () => ({ kind: 'intent', intent }),
    rejectIntent: async () => undefined,
    beginPublication: async () => 'missing',
    markPublished: async () => undefined,
    releasePublication: async () => undefined,
    cleanupCandidates: async () => [],
    removeCleanupCandidate: async () => false,
  };
  const storage: WritingChartUploadStoragePort = {
    createUploadUrl: async () => ({
      url: 'private',
      fields: {},
      expiresAt: new Date(NOW.getTime() + 60_000),
    }),
    inspectObject: async () => undefined,
    publishObject: async () => undefined,
    publicUrl: () => 'https://public.invalid/chart',
    deleteStagingObject: async () => undefined,
    deletePublishedObject: async () => undefined,
  };
  return new WritingChartUploadService(
    repository,
    storage,
    () => ASSET,
    () => NOW,
  );
}

describe('WritingChartUploadService', () => {
  it('uses a short retry delay for raster capacity but keeps the quota window', async () => {
    const service = setup();
    const admissions = Array.from({ length: 4 }, () =>
      reserveWritingChartRasterImageProcessing(),
    );
    const context = {
      requestId: 'req_01J00000000000000000000000',
      receivedAt: NOW,
      deadlineAt: new Date(NOW.getTime() + 10_000),
      operationTimeoutMs: 10_000,
      organizationId: intent.organizationId,
      userId: intent.endUserId,
      environment: intent.environment,
      scopes: [],
      signal: new AbortController().signal,
    };

    try {
      await expect(
        service.complete({ context, assetId: ASSET }),
      ).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        retryAfterMs: 1_000,
      });
    } finally {
      for (const admission of admissions) admission.release();
    }

    await expect(
      service.create({ context, contentType: 'image/png', byteSize: 12 }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 60 * 60 * 1000,
    });
  });
});
