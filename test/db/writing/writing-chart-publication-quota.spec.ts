import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createFixturePrismaClient } from '@/modules/persistence/infrastructure/prisma-client';
import type { WritingChartUploadOwner } from '@/modules/writing/application/writing-chart-upload.port';
import {
  PostgresWritingChartUploadRepository,
  writingChartPublicationLockKey,
} from '@/modules/writing/infrastructure/postgres-writing-chart-upload.repository';
import { createTestPool, testDatabaseUrl } from '../shared/database';

// The Organization's hourly publication limit holds while another publication
// moves from publishing to published (#1000). markPublished takes the same
// lock as admission, so admission never counts a row in neither state.

const ORGANIZATION_ID = 'org_chart_quota';
const END_USER_ID = 'learner-quota';
const NOW = new Date();

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

beforeEach(async () => {
  await pool.query(
    'DELETE FROM writing_chart_uploads WHERE organization_id = $1',
    [ORGANIZATION_ID],
  );
});

const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

/** An upload created 65 minutes ago, so it no longer counts as a recent intent. */
async function insertUpload(
  status: 'open' | 'publishing' | 'published',
): Promise<WritingChartUploadOwner> {
  const assetId = `chart_${ulid()}`;
  const published = status === 'published';
  await pool.query(
    `INSERT INTO writing_chart_uploads
       (id, organization_id, end_user_id, environment, staging_key, published_key,
        content_type, byte_size, status, image_url, created_at, expires_at,
        published_at, retention_expires_at, publication_started_at)
     VALUES ($1, $2, $3, 'production', $4, $5, 'image/png', 1, $6, $7, $8, $9,
             $10, $11, $12)`,
    [
      assetId,
      ORGANIZATION_ID,
      END_USER_ID,
      `writing-charts/${assetId}/staging`,
      `writing-charts/${assetId}/published`,
      status,
      published
        ? `https://s3.wispace.app/aihub-writing-charts/${assetId}`
        : null,
      minutesAgo(65),
      new Date(NOW.getTime() + 60 * 60_000),
      published ? minutesAgo(10) : null,
      published ? new Date(NOW.getTime() + 24 * 60 * 60_000) : null,
      status === 'publishing' ? NOW : null,
    ],
  );
  return {
    assetId,
    organizationId: ORGANIZATION_ID,
    endUserId: END_USER_ID,
    environment: 'production',
  };
}

async function holdPublicationLock() {
  const session = await pool.connect();
  await session.query('BEGIN');
  await session.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    writingChartPublicationLockKey(ORGANIZATION_ID),
  ]);
  return async () => {
    await session.query('COMMIT');
    session.release();
  };
}

describe('Writing chart publication limit during a concurrent publish', () => {
  it('marks a publication published only under the admission lock', async () => {
    const inFlight = await insertUpload('publishing');
    const release = await holdPublicationLock();

    let settled = false;
    const marking = repository
      .markPublished({
        owner: inFlight,
        now: NOW,
        imageUrl: 'https://s3.wispace.app/x',
      })
      .then((asset) => {
        settled = true;
        return asset;
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);

    await release();
    await expect(marking).resolves.toMatchObject({ status: 'published' });
  });

  it('refuses a sixth publication while the fifth completes', async () => {
    for (let index = 0; index < 4; index += 1) await insertUpload('published');
    const inFlight = await insertUpload('publishing');
    const sixth = await insertUpload('open');
    const release = await holdPublicationLock();

    // Both wait on the lock; whichever runs first, the in-flight one counts once.
    const marking = repository.markPublished({
      owner: inFlight,
      now: NOW,
      imageUrl: 'https://s3.wispace.app/x',
    });
    const admitting = repository.beginPublication({ owner: sixth, now: NOW });
    await release();

    await expect(marking).resolves.toMatchObject({ status: 'published' });
    await expect(admitting).resolves.toBe('limited');
  });

  it('never admits past the limit when admissions race each other', async () => {
    for (let index = 0; index < 4; index += 1) await insertUpload('published');
    const candidates = await Promise.all(
      [0, 1, 2].map(() => insertUpload('open')),
    );

    const outcomes = await Promise.all(
      candidates.map((owner) =>
        repository.beginPublication({ owner, now: NOW }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === 'started')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'limited')).toHaveLength(2);
  });
});
