import type { UploadSessionServicePort } from '@/modules/uploads/public';
import { WritingChartUploadService } from './writing-chart-upload.service';

const NOW = new Date('2026-11-17T00:00:00.000Z');
const ASSET = 'chart_01J00000000000000000000001';

const grant = {
  assetId: ASSET,
  contentType: 'image/png',
  byteSize: 12,
  uploadUrl: 'private',
  uploadFields: {},
  uploadUrlExpiresAt: new Date(NOW.getTime() + 300_000),
  intentExpiresAt: new Date(NOW.getTime() + 3_600_000),
};

const asset = {
  assetId: ASSET,
  organizationId: 'org_01J00000000000000000000000',
  endUserId: 'usr_01J00000000000000000000000',
  environment: 'production' as const,
  stagingKey: `writing-charts/${ASSET}/staging`,
  publishedKey: `writing-charts/${ASSET}/published`,
  contentType: 'image/png',
  byteSize: 12,
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  status: 'published' as const,
  publishedAt: NOW,
  retentionExpiresAt: new Date(NOW.getTime() + 86_400_000),
  imageUrl: 'https://public.invalid/chart',
};

const context = {
  requestId: 'req_01J00000000000000000000000',
  receivedAt: NOW,
  deadlineAt: new Date(NOW.getTime() + 10_000),
  operationTimeoutMs: 10_000,
  organizationId: asset.organizationId,
  userId: asset.endUserId,
  environment: asset.environment,
  scopes: [],
  signal: new AbortController().signal,
};

function setup() {
  const create = jest.fn(async () => grant);
  const refresh = jest.fn(async () => grant);
  const complete = jest.fn(async () => asset);
  const core: UploadSessionServicePort = { create, refresh, complete };
  return {
    create,
    refresh,
    complete,
    service: new WritingChartUploadService(core),
  };
}

describe('WritingChartUploadService', () => {
  it('delegates create, refresh and completion to the shared core', async () => {
    const { create, refresh, complete, service } = setup();

    await expect(
      service.create({ context, contentType: 'image/png', byteSize: 12 }),
    ).resolves.toEqual(grant);
    await expect(service.refresh({ context, assetId: ASSET })).resolves.toEqual(
      grant,
    );
    await expect(service.complete({ context, assetId: ASSET })).resolves.toBe(
      asset,
    );

    expect(create).toHaveBeenCalledWith({
      context,
      contentType: 'image/png',
      byteSize: 12,
    });
    expect(refresh).toHaveBeenCalledWith({ context, assetId: ASSET });
    expect(complete).toHaveBeenCalledWith({ context, assetId: ASSET });
  });
});
