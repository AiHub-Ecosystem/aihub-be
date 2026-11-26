import { UploadSessionService } from './upload-session.service';

const NOW = new Date('2026-11-26T00:00:00.000Z');
const ASSET = 'ava_01J00000000000000000000001';

describe('UploadSessionService Avatar seams', () => {
  it('passes stored content type and byte size to publication', async () => {
    const stored = {
      contentType: 'image/png',
      byteSize: 12,
      bytes: new Uint8Array(12),
      lastModified: NOW,
      etag: 'etag-1',
    };
    const repository = {
      createIntent: jest.fn(async () => true),
      findUpload: jest.fn(async () => ({
        kind: 'intent' as const,
        intent: {
          assetId: ASSET,
          endUserId: 'usr_01J00000000000000000000000',
          environment: 'production' as const,
          stagingKey: 'users/u/avatar/a/original',
          publishedKey: 'users/u/avatar/a/original',
          contentType: 'image/jpeg',
          byteSize: 0,
          createdAt: NOW,
          expiresAt: new Date(NOW.getTime() + 300_000),
          status: 'open' as const,
        },
      })),
      rejectIntent: jest.fn(async () => undefined),
      beginPublication: jest.fn(async () => 'started' as const),
      markPublished: jest.fn(async () => ({
        assetId: ASSET,
        endUserId: 'usr_01J00000000000000000000000',
        environment: 'production' as const,
        stagingKey: 'users/u/avatar/a/original',
        publishedKey: 'users/u/avatar/a/original',
        contentType: 'image/png',
        byteSize: 12,
        createdAt: NOW,
        expiresAt: NOW,
        status: 'published' as const,
        publishedAt: NOW,
        imageUrl: 'url',
      })),
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
      inspectObject: jest.fn(async () => stored),
      publishObject: jest.fn(async () => undefined),
      publicUrl: jest.fn(() => 'url'),
      deleteStagingObject: jest.fn(async () => undefined),
      deletePublishedObject: jest.fn(async () => undefined),
    };
    const policy = {
      maxBytes: 2 * 1024 * 1024,
      intentTtlMs: 300_000,
      rateWindowMs: 3_600_000,
      orphanGraceMs: 86_400_000,
      owner: jest.fn(() => ({
        assetId: ASSET,
        endUserId: 'usr_01J00000000000000000000000',
        environment: 'production' as const,
      })),
      isContentType: () => true,
      isAssetId: () => true,
      stagingKey: (owner: { assetId: string }) =>
        `users/u/avatar/${owner.assetId}/original`,
      publishedKey: (owner: { assetId: string }) =>
        `users/u/avatar/${owner.assetId}/original`,
      invalidStoredObject: () => undefined,
      reserveVerification: () => ({ release: () => undefined }),
      verify: async () => ({ kind: 'sanitized' as const, bytes: stored.bytes }),
      invalidRequest: () => new Error('invalid') as never,
      payloadTooLarge: () => new Error('too large') as never,
      rateLimited: () => new Error('rate limited') as never,
      storageUnavailable: () => new Error('unavailable') as never,
      notFound: () => new Error('not found') as never,
    };
    const service = new UploadSessionService(
      repository as never,
      storage as never,
      policy as never,
      () => ASSET,
      () => NOW,
    );

    await service.complete({
      context: {
        requestId: 'req-1',
        receivedAt: NOW,
        deadlineAt: NOW,
        operationTimeoutMs: 20_000,
        userId: 'usr_01J00000000000000000000000',
        scopes: [],
        signal: new AbortController().signal,
      },
      assetId: ASSET,
    });

    expect(repository.markPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        contentType: 'image/png',
        byteSize: 12,
      }),
    );
  });
});
