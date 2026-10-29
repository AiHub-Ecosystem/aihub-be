import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { runWritingChartRevokeCommand } from '@/cli/writing-chart-revoke';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import { createFixturePrismaClient } from '@/modules/persistence/infrastructure/prisma-client';
import type { WritingChartUploadStoragePort } from '@/modules/writing/application/writing-chart-upload.port';
import { WritingChartUploadService } from '@/modules/writing/application/writing-chart-upload.service';
import { PostgresWritingChartRevocationAuditRepository } from '@/modules/writing/infrastructure/postgres-writing-chart-revocation-audit.repository';
import { PostgresWritingChartUploadRepository } from '@/modules/writing/infrastructure/postgres-writing-chart-upload.repository';
import { createTestPool, testDatabaseUrl } from '../shared/database';

// An operator revocation fences the upload from publishing again (#1206). The
// repositories, service, and revoke command are real; only object storage and
// the public-edge probe are doubles, sharing one in-memory bucket.

const CHART_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
);
const ORGANIZATION_ID = 'org_chart_fence';
const BUCKET = 'aihub-writing-charts';
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

/** One bucket the service publishes to and the revoke command deletes from. */
class Bucket {
  readonly published = new Set<string>();
  publishes = 0;
  /** Writes the object, then loses the acknowledgement. */
  loseNextAck = false;
  /** Holds the next public write until released. */
  gate: Promise<void> | undefined;

  storage(): WritingChartUploadStoragePort {
    return {
      createUploadUrl: async () => ({
        url: 'https://storage.test/upload',
        fields: {},
        expiresAt: new Date(Date.now() + 300_000),
      }),
      inspectObject: async () => ({
        contentType: 'image/png',
        byteSize: CHART_PNG.length,
        bytes: new Uint8Array(CHART_PNG),
      }),
      publishObject: async (input) => {
        await this.gate;
        this.publishes += 1;
        this.published.add(input.publishedKey);
        if (this.loseNextAck) {
          this.loseNextAck = false;
          throw new Error('connection reset after the write');
        }
      },
      publicUrl: (input) =>
        `https://s3.wispace.app/${BUCKET}/${input.publishedKey}`,
      deleteStagingObject: async () => undefined,
      deletePublishedObject: async (input) => {
        this.published.delete(input.publishedKey);
      },
    };
  }

  async revoke(url: string, now = new Date()) {
    return runWritingChartRevokeCommand({
      databaseUrl: testDatabaseUrl(),
      environment: 'production',
      url,
      actorUsername: operator,
      audit: new PostgresWritingChartRevocationAuditRepository(client),
      storage: {
        deletePublishedObjectIfPresent: async ({ publishedKey }) =>
          this.published.delete(publishedKey) ? 'deleted' : 'already_absent',
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

function context() {
  return createRequestContext({
    requestId: `req_${ulid()}`,
    receivedAt: new Date(),
    deadlineMs: 10_000,
    organizationId: ORGANIZATION_ID,
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

  it('makes a publisher already past its reservation remove what it wrote, and reports the revocation pending until then', async () => {
    const bucket = new Bucket();
    const { service, assetId, publishedKey, url } = await openUpload(bucket);
    let release: () => void = () => undefined;
    bucket.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completion = service.complete({ context: context(), assetId });
    // A separate service instance cannot see the first one's in-memory queue.
    while ((await uploadStatus(assetId)) !== 'publishing') {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

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
});
