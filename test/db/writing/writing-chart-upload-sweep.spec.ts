import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import { createFixturePrismaClient } from '@/modules/persistence/infrastructure/prisma-client';
import type { WritingChartUploadOwner } from '@/modules/writing/application/writing-chart-upload.port';
import { WritingChartUploadService } from '@/modules/writing/application/writing-chart-upload.service';
import { WritingChartUploadSweep } from '@/modules/writing/application/writing-chart-upload.sweep';
import { PostgresWritingChartUploadRepository } from '@/modules/writing/infrastructure/postgres-writing-chart-upload.repository';
import { createTestPool, testDatabaseUrl } from '../shared/database';
import { CHART_PNG, ChartBucket } from './support/chart-bucket';

// The sweep deletes the public object of every upload it removes, whatever the
// row said (#921). The repository, service, and sweep are real; only object
// storage is a double. The sweep runs at a later `now` so the rows are expired
// without touching the database clock.

const ORGANIZATION_ID = 'org_chart_sweep';
const END_USER_ID = 'learner-sweep';
const PAST_THE_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

let pool: Pool;
let client: ReturnType<typeof createFixturePrismaClient>;
let repository: PostgresWritingChartUploadRepository;

beforeAll(() => {
  pool = createTestPool();
  client = createFixturePrismaClient(testDatabaseUrl());
  repository = new PostgresWritingChartUploadRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

function context() {
  return createRequestContext({
    requestId: `req_${ulid()}`,
    receivedAt: new Date(),
    deadlineMs: 10_000,
    organizationId: ORGANIZATION_ID,
    environment: 'production',
    userId: END_USER_ID,
    scopes: ['writing:grade'],
  });
}

/** An open upload whose private object is staged in the bucket. */
async function openUpload(bucket: ChartBucket) {
  const service = new WritingChartUploadService(
    repository,
    bucket.storage(),
    (now) => `chart_${ulid(now.getTime())}`,
  );
  const { assetId } = await service.create({
    context: context(),
    contentType: 'image/png',
    byteSize: CHART_PNG.length,
  });
  const stagingKey = `writing-charts/${assetId}/staging`;
  bucket.staged.add(stagingKey);
  const owner: WritingChartUploadOwner = {
    assetId,
    organizationId: ORGANIZATION_ID,
    endUserId: END_USER_ID,
    environment: 'production',
  };
  return {
    service,
    owner,
    assetId,
    stagingKey,
    publishedKey: `writing-charts/${assetId}/published`,
  };
}

async function uploadStatus(assetId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM writing_chart_uploads WHERE id = $1',
    [assetId],
  );
  return rows[0]?.status;
}

function sweepAt(bucket: ChartBucket, now: Date) {
  return new WritingChartUploadSweep(repository, bucket.storage()).run({
    dryRun: false,
    now,
  });
}

describe('Writing chart upload sweep', () => {
  beforeEach(async () => {
    await pool.query(
      'DELETE FROM writing_chart_uploads WHERE organization_id = $1',
      [ORGANIZATION_ID],
    );
  });

  it('deletes the published object of an expired publishing row', async () => {
    const bucket = new ChartBucket();
    const { owner, assetId, stagingKey, publishedKey } =
      await openUpload(bucket);
    // The process stopped after the object was written and before it was marked.
    await expect(
      repository.beginPublication({ owner, now: new Date() }),
    ).resolves.toBe('started');
    bucket.published.add(publishedKey);
    expect(await uploadStatus(assetId)).toBe('publishing');

    await sweepAt(bucket, new Date(Date.now() + PAST_THE_GRACE_PERIOD_MS));

    expect(bucket.published.has(publishedKey)).toBe(false);
    expect(bucket.staged.has(stagingKey)).toBe(false);
    expect(await uploadStatus(assetId)).toBeUndefined();
  });

  it('deletes the published object of an expired row returned to open after a lost acknowledgement', async () => {
    const bucket = new ChartBucket();
    const { service, assetId, stagingKey, publishedKey } =
      await openUpload(bucket);
    bucket.loseNextAck = true;
    await expect(
      service.complete({ context: context(), assetId }),
    ).rejects.toThrow('connection reset after the write');
    expect(bucket.published.has(publishedKey)).toBe(true);
    expect(await uploadStatus(assetId)).toBe('open');

    await sweepAt(bucket, new Date(Date.now() + PAST_THE_GRACE_PERIOD_MS));

    expect(bucket.published.has(publishedKey)).toBe(false);
    expect(bucket.staged.has(stagingKey)).toBe(false);
    expect(await uploadStatus(assetId)).toBeUndefined();
  });

  it('leaves a row that has not expired, and its published object, alone', async () => {
    const bucket = new ChartBucket();
    const { service, assetId, stagingKey, publishedKey } =
      await openUpload(bucket);
    bucket.loseNextAck = true;
    await expect(
      service.complete({ context: context(), assetId }),
    ).rejects.toThrow('connection reset after the write');

    await sweepAt(bucket, new Date());

    expect(bucket.published.has(publishedKey)).toBe(true);
    expect(bucket.staged.has(stagingKey)).toBe(true);
    expect(await uploadStatus(assetId)).toBe('open');
  });
});
