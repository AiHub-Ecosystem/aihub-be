import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { runWritingChartRevokeCommand } from '@/cli/writing-chart-revoke';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import { createFixturePrismaClient } from '@/modules/persistence/infrastructure/prisma-client';
import type { WritingChartUploadRepositoryPort } from '@/modules/writing/application/writing-chart-upload.port';
import { WritingChartUploadService } from '@/modules/writing/application/writing-chart-upload.service';
import { PostgresWritingChartRevocationAuditRepository } from '@/modules/writing/infrastructure/postgres-writing-chart-revocation-audit.repository';
import { PostgresWritingChartUploadRepository } from '@/modules/writing/infrastructure/postgres-writing-chart-upload.repository';
import { createTestPool, testDatabaseUrl } from '../shared/database';
import { BUCKET, CHART_PNG, ChartBucket } from './support/chart-bucket';

// An operator revocation fences the upload from publishing again (#1206). The
// repositories, service, and revoke command are real; only object storage and
// the public-edge probe are doubles, sharing one in-memory bucket.

const ORGANIZATION_ID = 'org_chart_fence';
const ACTIVE_AT = new Date('2026-10-01T00:00:00.000Z');

let pool: Pool;
let client: ReturnType<typeof createFixturePrismaClient>;
let operator: string;

beforeAll(async () => {
  pool = createTestPool();
  client = createFixturePrismaClient(testDatabaseUrl());
  operator = `op${ulid().slice(-10).toLowerCase()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [`usr_${ulid()}`, operator, ACTIVE_AT],
  );
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

/** The shared bucket, which the revoke command also deletes from. */
class Bucket extends ChartBucket {
  failNextRevokeDelete = false;

  async revoke(url: string, now = new Date()) {
    return runWritingChartRevokeCommand({
      databaseUrl: testDatabaseUrl(),
      environment: 'production',
      url,
      actorUsername: operator,
      audit: new PostgresWritingChartRevocationAuditRepository(client),
      storage: {
        deletePublishedObjectIfPresent: async ({ publishedKey }) => {
          if (this.failNextRevokeDelete) {
            this.failNextRevokeDelete = false;
            throw new Error('simulated object-store delete failure');
          }
          return this.published.delete(publishedKey)
            ? 'deleted'
            : 'already_absent';
        },
      },
      probe: async () =>
        this.published.size === 0
          ? { state: 'not_serving', status: 404 }
          : { state: 'serving', status: 200 },
      emit: () => undefined,
      now: () => now,
    });
  }
}

function context(organizationId = ORGANIZATION_ID) {
  return createRequestContext({
    requestId: `req_${ulid()}`,
    receivedAt: new Date(),
    deadlineMs: 10_000,
    organizationId,
    environment: 'production',
    userId: 'learner-fence',
    scopes: ['writing:grade'],
  });
}

/** An open upload and a service bound to the shared bucket. */
async function openUpload(bucket: Bucket) {
  const service = new WritingChartUploadService(
    new PostgresWritingChartUploadRepository(client),
    bucket.storage(),
    (now) => `chart_${ulid(now.getTime())}`,
  );
  const { assetId } = await service.create({
    context: context(),
    contentType: 'image/png',
    byteSize: CHART_PNG.length,
  });
  const publishedKey = `writing-charts/${assetId}/published`;
  return {
    service,
    assetId,
    publishedKey,
    url: `https://s3.wispace.app/${BUCKET}/${publishedKey}`,
  };
}

async function uploadStatus(assetId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM writing_chart_uploads WHERE id = $1',
    [assetId],
  );
  return rows[0]?.status;
}

describe('Writing chart publication after an operator revocation', () => {
  beforeEach(async () => {
    await pool.query(
      'DELETE FROM writing_chart_uploads WHERE organization_id = $1',
      [ORGANIZATION_ID],
    );
  });

  it('keeps a revoked key absent when completion is retried after an ambiguous write', async () => {
    const bucket = new Bucket();
    const { service, assetId, publishedKey, url } = await openUpload(bucket);

    bucket.loseNextAck = true;
    await expect(
      service.complete({ context: context(), assetId }),
    ).rejects.toThrow('connection reset after the write');
    expect(bucket.published.has(publishedKey)).toBe(true);
    expect(await uploadStatus(assetId)).toBe('open');

    await expect(bucket.revoke(url)).resolves.toMatchObject({
      origin: 'deleted',
      edge: { state: 'not_serving', status: 404 },
      publicationPending: false,
    });

    await expect(
      service.complete({ context: context(), assetId }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(bucket.published.has(publishedKey)).toBe(false);
    expect(bucket.publishes).toBe(1);
  });

  it('stops reporting a published asset once it is revoked', async () => {
    const bucket = new Bucket();
    const { service, assetId, url } = await openUpload(bucket);
    await expect(
      service.complete({ context: context(), assetId }),
    ).resolves.toMatchObject({
      status: 'published',
    });

    await bucket.revoke(url);

    await expect(
      service.complete({ context: context(), assetId }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(bucket.published.size).toBe(0);
  });

  it('answers not-found for the same End-User ID under another Organization', async () => {
    const bucket = new Bucket();
    const { service, assetId } = await openUpload(bucket);

    await expect(
      service.refresh({
        context: context('org_chart_other'),
        assetId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('makes a publisher already past its reservation remove what it wrote, and reports the revocation pending until then', async () => {
    const bucket = new Bucket();
    const { service, assetId, publishedKey, url } = await openUpload(bucket);
    let release: () => void = () => undefined;
    bucket.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completion = service.complete({ context: context(), assetId });
    // A separate service instance cannot see the first one's in-memory queue.
    await bucket.publishStarted;

    await expect(bucket.revoke(url)).resolves.toMatchObject({
      publicationPending: true,
    });
    release();
    await expect(completion).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(bucket.published.has(publishedKey)).toBe(false);
    expect(await uploadStatus(assetId)).toBe('rejected');
    await expect(bucket.revoke(url)).resolves.toMatchObject({
      origin: 'already_absent',
      edge: { state: 'not_serving' },
      publicationPending: false,
    });
  });

  it('reports a publication past its deadline as settled', async () => {
    const bucket = new Bucket();
    const { assetId, url } = await openUpload(bucket);
    await pool.query(
      `UPDATE writing_chart_uploads
       SET status = 'publishing', publication_started_at = now() - interval '1 minute'
       WHERE id = $1`,
      [assetId],
    );

    await expect(bucket.revoke(url)).resolves.toMatchObject({
      publicationPending: false,
    });
  });

  it('fences a pre-fence publisher and holds the revoke pending for one lease', async () => {
    const bucket = new Bucket();
    const { service, assetId, url } = await openUpload(bucket);
    await pool.query(
      `UPDATE writing_chart_uploads
       SET status = 'publishing', publication_started_at = NULL
       WHERE id = $1`,
      [assetId],
    );
    const revokedAt = new Date();

    await expect(bucket.revoke(url, revokedAt)).resolves.toMatchObject({
      publicationPending: true,
    });
    expect(await uploadStatus(assetId)).toBe('rejected');
    const oldPublisherMark = await pool.query(
      `UPDATE writing_chart_uploads
       SET status = 'published'
       WHERE id = $1 AND status = 'publishing'`,
      [assetId],
    );
    expect(oldPublisherMark.rowCount).toBe(0);
    await expect(
      service.complete({ context: context(), assetId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      bucket.revoke(url, new Date(revokedAt.getTime() + 31_000)),
    ).resolves.toMatchObject({
      origin: 'already_absent',
      publicationPending: false,
    });
  });

  it('still deletes by key when the upload row is already pruned', async () => {
    const bucket = new Bucket();
    const { publishedKey, url, assetId } = await openUpload(bucket);
    bucket.published.add(publishedKey);
    await pool.query('DELETE FROM writing_chart_uploads WHERE id = $1', [
      assetId,
    ]);

    await expect(bucket.revoke(url)).resolves.toMatchObject({
      origin: 'deleted',
      publicationPending: false,
    });
    await expect(bucket.revoke(url)).resolves.toMatchObject({
      origin: 'already_absent',
    });
  });

  it('does not let an old release or mark replace a newer publication reservation', async () => {
    const bucket = new Bucket();
    const { assetId } = await openUpload(bucket);
    const owner = {
      assetId,
      organizationId: ORGANIZATION_ID,
      endUserId: 'learner-fence',
      environment: 'production' as const,
    };
    const first = new PostgresWritingChartUploadRepository(client);
    const second = new PostgresWritingChartUploadRepository(client);
    const firstStartedAt = new Date();
    const secondStartedAt = new Date(firstStartedAt.getTime() + 31_000);

    await expect(
      first.beginPublication({ owner, now: firstStartedAt }),
    ).resolves.toBe('started');
    await expect(
      second.beginPublication({
        owner,
        now: new Date(firstStartedAt.getTime() + 1_000),
      }),
    ).resolves.toBe('in_progress');
    await expect(
      second.beginPublication({ owner, now: secondStartedAt }),
    ).resolves.toBe('started');

    await first.releasePublication(owner, firstStartedAt);
    await expect(
      first.markPublished({
        owner,
        now: secondStartedAt,
        publicationStartedAt: firstStartedAt,
        imageUrl: 'https://s3.wispace.app/x',
      }),
    ).resolves.toBeUndefined();
    expect(await uploadStatus(assetId)).toBe('publishing');

    await expect(
      second.markPublished({
        owner,
        now: secondStartedAt,
        publicationStartedAt: secondStartedAt,
        imageUrl: 'https://s3.wispace.app/x',
      }),
    ).resolves.toMatchObject({ status: 'published' });
  });

  it('keeps a failed mark behind the durable revoke fence and supports a revoke retry', async () => {
    const bucket = new Bucket();
    const { assetId, publishedKey, url } = await openUpload(bucket);
    let markEntered: () => void = () => {};
    let releaseMark: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseMark = resolve;
    });
    class FailedMarkRepository extends PostgresWritingChartUploadRepository {
      override async markPublished(
        _input: Parameters<
          WritingChartUploadRepositoryPort['markPublished']
        >[0],
      ): Promise<
        Awaited<ReturnType<WritingChartUploadRepositoryPort['markPublished']>>
      > {
        markEntered();
        await gate;
        throw new Error('simulated database failure before mark commit');
      }
    }
    const service = new WritingChartUploadService(
      new FailedMarkRepository(client),
      bucket.storage(),
      (now) => `chart_${ulid(now.getTime())}`,
    );
    const completion = service.complete({ context: context(), assetId });
    await entered;

    await expect(bucket.revoke(url)).resolves.toMatchObject({
      origin: 'deleted',
      edge: { state: 'not_serving', status: 404 },
      publicationPending: true,
    });
    releaseMark();
    await expect(completion).rejects.toThrow(
      'simulated database failure before mark commit',
    );

    expect(bucket.published.has(publishedKey)).toBe(false);
    expect(await uploadStatus(assetId)).toBe('rejected');
    const restarted = new WritingChartUploadService(
      new PostgresWritingChartUploadRepository(client),
      bucket.storage(),
      (now) => `chart_${ulid(now.getTime())}`,
    );
    await expect(
      restarted.complete({ context: context(), assetId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(bucket.publishes).toBe(1);
  });

  it('keeps a failed revocation delete fenced and retryable', async () => {
    const bucket = new Bucket();
    const { service, assetId, publishedKey, url } = await openUpload(bucket);
    bucket.published.add(publishedKey);
    bucket.failNextRevokeDelete = true;
    await expect(bucket.revoke(url)).resolves.toMatchObject({
      origin: 'failed',
      edge: { state: 'serving', status: 200 },
    });
    await expect(
      service.complete({ context: context(), assetId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(bucket.revoke(url)).resolves.toMatchObject({
      origin: 'deleted',
      edge: { state: 'not_serving', status: 404 },
    });
    expect(bucket.published.has(publishedKey)).toBe(false);
  });
});
