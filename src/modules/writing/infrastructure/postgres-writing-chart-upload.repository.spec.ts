import type { Prisma, PrismaClient } from '@prisma-client/client';

import type { WritingChartUploadIntent } from '@/modules/writing/domain/writing-chart-upload';
import { PostgresWritingChartUploadRepository } from './postgres-writing-chart-upload.repository';

function fakePrisma(count: jest.Mock) {
  const lock = jest.fn().mockResolvedValue(undefined);
  const create = jest.fn().mockResolvedValue(undefined);
  const findFirst = jest.fn();
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const transaction = {
    $executeRawUnsafe: lock,
    writingChartUpload: { count, create, findFirst, updateMany },
    writingChartRevocationAudit: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  } as unknown as Prisma.TransactionClient;
  const runTransaction = jest.fn(
    async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(transaction),
  );
  const client = { $transaction: runTransaction } as unknown as PrismaClient;
  return { client, lock, create, count, findFirst, updateMany };
}

const intent: WritingChartUploadIntent = {
  assetId: 'chart_01J00000000000000000000001',
  organizationId: 'org_chart_upload',
  endUserId: 'learner-42',
  environment: 'production',
  stagingKey: 'writing-charts/chart_01J00000000000000000000001/staging',
  publishedKey: 'writing-charts/chart_01J00000000000000000000001/published',
  contentType: 'image/png',
  byteSize: 1,
  createdAt: new Date('2026-10-14T12:00:00.000Z'),
  expiresAt: new Date('2026-10-14T13:00:00.000Z'),
  status: 'open',
};

describe('PostgresWritingChartUploadRepository Organization limits', () => {
  it('shares the intent counter and advisory lock across environments', async () => {
    const { client, count, create, lock } = fakePrisma(
      jest.fn().mockResolvedValue(5),
    );
    const repository = new PostgresWritingChartUploadRepository(client);

    await expect(repository.createIntent(intent)).resolves.toBe(false);

    expect(lock).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'org_chart_upload:writing-chart:intents',
    );
    expect(count).toHaveBeenCalledWith({
      where: {
        organizationId: intent.organizationId,
        createdAt: { gt: new Date('2026-10-14T11:00:00.000Z') },
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('shares the publication counter across environments', async () => {
    const count = jest.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(0);
    const { client, lock, findFirst } = fakePrisma(count);
    findFirst.mockResolvedValue(intent);
    const repository = new PostgresWritingChartUploadRepository(client);

    await expect(
      repository.beginPublication({
        owner: {
          assetId: intent.assetId,
          organizationId: intent.organizationId,
          endUserId: intent.endUserId,
          environment: 'production',
        },
        now: new Date('2026-10-14T12:00:00.000Z'),
      }),
    ).resolves.toBe('limited');

    expect(lock).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'org_chart_upload:writing-chart:publications',
    );
    expect(count).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: intent.organizationId,
        status: 'published',
        publishedAt: { gt: new Date('2026-10-14T11:00:00.000Z') },
      },
    });
    // Only reservations inside their 30-second lease hold a slot (#915).
    expect(count).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: intent.organizationId,
        status: 'publishing',
        OR: [
          { publicationStartedAt: null },
          {
            publicationStartedAt: { gt: new Date('2026-10-14T11:59:30.000Z') },
          },
        ],
      },
    });
  });

  it('does not replace a publication reservation while its lease is live', async () => {
    const { client, count, findFirst, updateMany } = fakePrisma(
      jest.fn().mockResolvedValue(0),
    );
    const now = new Date('2026-10-14T12:00:00.000Z');
    findFirst.mockResolvedValue({
      ...intent,
      status: 'publishing',
      publicationStartedAt: new Date(now.getTime() - 1_000),
    });
    const repository = new PostgresWritingChartUploadRepository(client);

    await expect(
      repository.beginPublication({
        owner: {
          assetId: intent.assetId,
          organizationId: intent.organizationId,
          endUserId: intent.endUserId,
          environment: 'production',
        },
        now,
      }),
    ).resolves.toBe('in_progress');

    expect(count).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
