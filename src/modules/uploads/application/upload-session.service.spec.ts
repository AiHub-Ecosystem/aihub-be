import type { AppError } from '@/common/errors/app-error';
import { UploadSessionService } from './upload-session.service';

const NOW = new Date('2026-11-26T00:00:00.000Z');
const ASSET = 'chart_01J00000000000000000000001';
const ORG = 'org_01J00000000000000000000000';
const USER = 'usr_01J00000000000000000000000';

function context() {
  return {
    requestId: 'req_01J00000000000000000000000',
    receivedAt: NOW,
    deadlineAt: new Date(NOW.getTime() + 10_000),
    operationTimeoutMs: 10_000,
    organizationId: ORG,
    userId: USER,
    environment: 'production' as const,
    scopes: [],
    signal: new AbortController().signal,
  };
}

function setup() {
  const published = {
    assetId: ASSET,
    organizationId: ORG,
    endUserId: USER,
    environment: 'production' as const,
    stagingKey: `writing-charts/${ASSET}/staging`,
    publishedKey: `writing-charts/${ASSET}/published`,
    status: 'published' as const,
    contentType: 'image/png',
    byteSize: 12,
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    publishedAt: NOW,
    retentionExpiresAt: new Date(NOW.getTime() + 86_400_000),
    imageUrl: 'https://public.invalid/chart',
  };
  const repository = {
    createIntent: jest.fn(async () => true),
    findUpload: jest.fn(async () => ({
      kind: 'asset' as const,
      asset: published,
    })),
    rejectIntent: jest.fn(async () => undefined),
    beginPublication: jest.fn(async () => 'started' as const),
    markPublished: jest.fn(async () => published),
    releasePublication: jest.fn(async () => undefined),
    cleanupCandidates: jest.fn(async () => []),
    removeCleanupCandidate: jest.fn(async () => true),
  };
  const storage = {
    createUploadUrl: jest.fn(async () => ({
      url: 'private',
      fields: {},
      expiresAt: new Date(NOW.getTime() + 300_000),
    })),
    inspectObject: jest.fn(async () => undefined),
    publishObject: jest.fn(async () => undefined),
    publicUrl: jest.fn(() => published.imageUrl),
    deleteStagingObject: jest.fn(async () => undefined),
    deletePublishedObject: jest.fn(async () => undefined),
  };
  const policy = {
    maxBytes: 10 * 1024 * 1024,
    intentTtlMs: 60 * 60 * 1000,
    rateWindowMs: 60 * 60 * 1000,
    orphanGraceMs: 24 * 60 * 60 * 1000,
    isContentType: (value: string) =>
      value === 'image/png' || value === 'image/jpeg' || value === 'image/webp',
    isAssetId: (value: string) => value === ASSET,
    stagingKey: (assetId: string) => `writing-charts/${assetId}/staging`,
    publishedKey: (assetId: string) => `writing-charts/${assetId}/published`,
    reserveVerification: () => ({ release: () => undefined }),
    verify: async () => ({
      kind: 'sanitized' as const,
      bytes: new Uint8Array(12),
    }),
    invalidRequest: (): AppError => new Error('invalid') as AppError,
    payloadTooLarge: (): AppError => new Error('too large') as AppError,
    rateLimited: (): AppError => new Error('rate limited') as AppError,
    storageUnavailable: (): AppError => new Error('unavailable') as AppError,
    notFound: (): AppError => new Error('not found') as AppError,
  };
  const service = new UploadSessionService(
    repository,
    storage,
    policy,
    () => ASSET,
    () => NOW,
  );
  return { service, repository, storage, policy, published };
}

describe('UploadSessionService', () => {
  it('returns the stored asset on repeated completion without publishing again', async () => {
    const { service, storage, published } = setup();

    const first = await service.complete({
      context: context(),
      assetId: ASSET,
    });
    const second = await service.complete({
      context: context(),
      assetId: ASSET,
    });

    expect(first).toEqual(published);
    expect(second).toEqual(published);
    expect(storage.publishObject).not.toHaveBeenCalled();
  });
});
