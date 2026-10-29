import { AppError } from '@/common/errors/app-error';
import { storeUnavailable } from '@/common/errors/upload-errors';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import {
  WRITING_CHART_ORG_HOURLY_LIMIT,
  WRITING_CHART_PUBLICATION_LEASE_MS,
  WRITING_CHART_RATE_WINDOW_MS,
  WRITING_CHART_RETENTION_MS,
} from '@/modules/writing/application/writing-chart-upload.policy';
import type {
  WritingChartCleanupCandidate,
  WritingChartUploadLookup,
  WritingChartUploadOwner,
  WritingChartUploadRepositoryPort,
} from '@/modules/writing/application/writing-chart-upload.port';
import {
  type WritingChartAsset,
  type WritingChartUploadIntent,
  isWritingChartContentType,
  isWritingChartEnvironment,
  isWritingChartUploadStatus,
} from '@/modules/writing/domain/writing-chart-upload';
import type {
  Prisma,
  PrismaClient,
  WritingChartUpload as WritingChartUploadModel,
} from '@prisma-client/client';

function mapIntent(row: WritingChartUploadModel): WritingChartUploadIntent {
  if (
    !isWritingChartContentType(row.contentType) ||
    !isWritingChartUploadStatus(row.status) ||
    !isWritingChartEnvironment(row.environment)
  ) {
    throw storeUnavailable(
      'INTERNAL_ERROR',
      'Writing chart store is unavailable',
      false,
      new Error('Writing chart upload intent is invalid'),
    );
  }
  return {
    assetId: row.id,
    organizationId: row.organizationId,
    endUserId: row.endUserId,
    environment: row.environment,
    stagingKey: row.stagingKey,
    publishedKey: row.publishedKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: row.status,
  };
}

function mapAsset(row: WritingChartUploadModel): WritingChartAsset | undefined {
  if (row.status === 'deleted') return undefined;
  if (
    row.status !== 'published' ||
    !isWritingChartContentType(row.contentType) ||
    (row.environment !== 'production' && row.environment !== 'sandbox') ||
    row.publishedAt === null ||
    row.retentionExpiresAt === null ||
    row.imageUrl === null
  ) {
    throw storeUnavailable(
      'INTERNAL_ERROR',
      'Writing chart store is unavailable',
      false,
      new Error('Writing chart asset is invalid'),
    );
  }
  return {
    ...mapIntent({ ...row, status: 'open' }),
    status: 'published',
    publishedAt: row.publishedAt,
    retentionExpiresAt: row.retentionExpiresAt,
    imageUrl: row.imageUrl,
  };
}

function ownerWhere(owner: WritingChartUploadOwner) {
  return {
    id: owner.assetId,
    organizationId: owner.organizationId,
    endUserId: owner.endUserId,
    environment: owner.environment,
  };
}

function advisoryKey(
  owner: Pick<WritingChartUploadOwner, 'organizationId'>,
  action: string,
) {
  return `${owner.organizationId}:writing-chart:${action}`;
}

/**
 * The lock publication and revocation share (#1206): a revocation requested
 * under it is seen by every later reservation and every later markPublished.
 */
export function writingChartPublicationLockKey(organizationId: string): string {
  return advisoryKey({ organizationId }, 'publications');
}

// Prisma's query path cannot deserialize PostgreSQL's void result.
export const WRITING_CHART_LOCK_SQL =
  'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

/** An operator requested this asset's revocation: it may never publish (#1206). */
async function isRevoked(
  client: Prisma.TransactionClient | PrismaClient,
  assetId: string,
): Promise<boolean> {
  const fence = await client.writingChartRevocationAudit.findFirst({
    where: { assetId, phase: 'requested' },
    select: { id: true },
  });
  return fence !== null;
}

export class PostgresWritingChartUploadRepository
  implements WritingChartUploadRepositoryPort
{
  constructor(private readonly client: PrismaClient) {}

  async createIntent(intent: WritingChartUploadIntent): Promise<boolean> {
    return this.transaction(async (client) => {
      await this.lock(client, advisoryKey(intent, 'intents'));
      const since = new Date(
        intent.createdAt.getTime() - WRITING_CHART_RATE_WINDOW_MS,
      );
      const count = await client.writingChartUpload.count({
        where: {
          organizationId: intent.organizationId,
          createdAt: { gt: since },
        },
      });
      if (count >= WRITING_CHART_ORG_HOURLY_LIMIT) return false;
      await client.writingChartUpload.create({
        data: {
          id: intent.assetId,
          organizationId: intent.organizationId,
          endUserId: intent.endUserId,
          environment: intent.environment,
          stagingKey: intent.stagingKey,
          publishedKey: intent.publishedKey,
          contentType: intent.contentType,
          byteSize: intent.byteSize,
          status: 'open',
          createdAt: intent.createdAt,
          expiresAt: intent.expiresAt,
        },
      });
      return true;
    });
  }

  async findUpload(
    owner: WritingChartUploadOwner,
  ): Promise<WritingChartUploadLookup> {
    const row = await this.run(() =>
      this.client.writingChartUpload.findFirst({ where: ownerWhere(owner) }),
    );
    if (row === null) return { kind: 'missing' };
    if (await this.run(() => isRevoked(this.client, row.id))) {
      return { kind: 'missing' };
    }
    if (['open', 'rejected', 'publishing'].includes(row.status)) {
      return { kind: 'intent', intent: mapIntent(row) };
    }
    const asset = mapAsset(row);
    return asset === undefined ? { kind: 'missing' } : { kind: 'asset', asset };
  }

  async rejectIntent(owner: WritingChartUploadOwner, now: Date): Promise<void> {
    await this.run(() =>
      this.client.writingChartUpload.updateMany({
        where: {
          ...ownerWhere(owner),
          status: 'open',
          expiresAt: { gt: now },
        },
        data: { status: 'rejected' },
      }),
    );
  }

  async beginPublication(input: {
    readonly owner: WritingChartUploadOwner;
    readonly now: Date;
  }): Promise<'started' | 'published' | 'limited' | 'missing'> {
    return this.transaction(async (client) => {
      await this.lock(client, advisoryKey(input.owner, 'publications'));
      const row = await client.writingChartUpload.findFirst({
        where: ownerWhere(input.owner),
      });
      if (row === null || (await isRevoked(client, row.id))) return 'missing';
      if (row.status === 'published') return 'published';
      if (
        !['open', 'publishing'].includes(row.status) ||
        row.expiresAt.getTime() <= input.now.getTime()
      )
        return 'missing';
      if (row.status === 'publishing') {
        // A retry resumes the publication, and its deadline starts again.
        await client.writingChartUpload.updateMany({
          where: { ...ownerWhere(input.owner), status: 'publishing' },
          data: { publicationStartedAt: input.now },
        });
        return 'started';
      }

      const since = new Date(
        input.now.getTime() - WRITING_CHART_RATE_WINDOW_MS,
      );
      const [published, publishing] = await Promise.all([
        client.writingChartUpload.count({
          where: {
            organizationId: input.owner.organizationId,
            status: 'published',
            publishedAt: { gt: since },
          },
        }),
        // A reservation past its lease belongs to a publisher that crashed or
        // gave up; it no longer holds a slot (#915). Rows the release before
        // 0055 reserved have no start time and still count.
        client.writingChartUpload.count({
          where: {
            organizationId: input.owner.organizationId,
            status: 'publishing',
            OR: [
              { publicationStartedAt: null },
              {
                publicationStartedAt: {
                  gt: new Date(
                    input.now.getTime() - WRITING_CHART_PUBLICATION_LEASE_MS,
                  ),
                },
              },
            ],
          },
        }),
      ]);
      if (published + publishing >= WRITING_CHART_ORG_HOURLY_LIMIT) {
        return 'limited';
      }
      await client.writingChartUpload.updateMany({
        where: { ...ownerWhere(input.owner), status: 'open' },
        data: { status: 'publishing', publicationStartedAt: input.now },
      });
      return 'started';
    });
  }

  async markPublished(input: {
    readonly owner: WritingChartUploadOwner;
    readonly now: Date;
    readonly imageUrl: string;
  }): Promise<WritingChartAsset | 'revoked' | undefined> {
    return this.transaction(async (client) => {
      await this.lock(client, advisoryKey(input.owner, 'publications'));
      if (await isRevoked(client, input.owner.assetId)) {
        await client.writingChartUpload.updateMany({
          where: { ...ownerWhere(input.owner), status: 'publishing' },
          data: { status: 'rejected', publicationStartedAt: null },
        });
        return 'revoked';
      }
      await client.writingChartUpload.updateMany({
        where: { ...ownerWhere(input.owner), status: 'publishing' },
        data: {
          publicationStartedAt: null,
          status: 'published',
          publishedAt: input.now,
          retentionExpiresAt: new Date(
            input.now.getTime() + WRITING_CHART_RETENTION_MS,
          ),
          imageUrl: input.imageUrl,
        },
      });
      const row = await client.writingChartUpload.findFirst({
        where: { ...ownerWhere(input.owner), status: 'published' },
      });
      return row === null ? undefined : mapAsset(row);
    });
  }

  async releasePublication(owner: WritingChartUploadOwner): Promise<void> {
    await this.run(() =>
      this.client.writingChartUpload.updateMany({
        where: { ...ownerWhere(owner), status: 'publishing' },
        data: { status: 'open', publicationStartedAt: null },
      }),
    );
  }

  async cleanupCandidates(input: {
    readonly now: Date;
    readonly orphanBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly WritingChartCleanupCandidate[]> {
    const rows = await this.run(() =>
      this.client.writingChartUpload.findMany({
        where: {
          AND: [
            {
              OR: [
                {
                  status: { in: ['open', 'rejected', 'publishing'] },
                  expiresAt: { lte: input.orphanBefore },
                },
                { status: 'published', retentionExpiresAt: { lte: input.now } },
              ],
            },
            ...(input.after === undefined
              ? []
              : [
                  {
                    OR: [
                      { createdAt: { gt: input.after.createdAt } },
                      {
                        createdAt: input.after.createdAt,
                        id: { gt: input.after.assetId },
                      },
                    ],
                  },
                ]),
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: input.limit,
      }),
    );
    return rows.map((row) => {
      if (!isWritingChartEnvironment(row.environment))
        throw storeUnavailable(
          'INTERNAL_ERROR',
          'Writing chart store is unavailable',
          false,
          new Error('Writing chart environment is invalid'),
        );
      return {
        kind: row.status === 'published' ? 'asset' : 'intent',
        assetId: row.id,
        environment: row.environment,
        stagingKey: row.stagingKey,
        publishedKey: row.publishedKey,
        createdAt: row.createdAt,
      };
    });
  }

  async removeCleanupCandidate(
    candidate: WritingChartCleanupCandidate,
  ): Promise<boolean> {
    const result = await this.run(() =>
      this.client.writingChartUpload.deleteMany({
        where: {
          id: candidate.assetId,
          environment: candidate.environment,
          status:
            candidate.kind === 'asset'
              ? 'published'
              : { in: ['open', 'rejected', 'publishing'] },
        },
      }),
    );
    return result.count === 1;
  }

  private async lock(
    client: Prisma.TransactionClient,
    key: string,
  ): Promise<void> {
    await client.$executeRawUnsafe(WRITING_CHART_LOCK_SQL, key);
  }

  private async transaction<T>(
    run: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.client.$transaction(
        (client) => run(client),
        CONTROL_PLANE_TRANSACTION_OPTIONS,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storeUnavailable(
        'INTERNAL_ERROR',
        'Writing chart store is unavailable',
        false,
        error,
      );
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storeUnavailable(
        'INTERNAL_ERROR',
        'Writing chart store is unavailable',
        false,
        error,
      );
    }
  }
}
