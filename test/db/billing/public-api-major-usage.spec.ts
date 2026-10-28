import type { Pool } from 'pg';

import type { PublicApiMajorUsageRow } from '@/modules/metering/application/public-api-major-usage';
import { PostgresPublicApiMajorUsageRepository } from '@/modules/metering/infrastructure/postgres-public-api-major-usage.repository';
import { createPostgresMeteringClient } from '@/modules/metering/infrastructure/postgres-usage.repository';
import type { PrismaMeteringClient } from '@/modules/metering/infrastructure/prisma-metering.client';
import { createTestPool, testDatabaseUrl } from '../shared/database';

let pool: Pool;
let client: PrismaMeteringClient;
let repository: PostgresPublicApiMajorUsageRepository;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresMeteringClient(testDatabaseUrl());
  repository = new PostgresPublicApiMajorUsageRepository(client);
});

afterAll(async () => {
  await client.$disconnect();
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE public_api_major_usage');
});

const row = (
  overrides: Partial<PublicApiMajorUsageRow> = {},
): PublicApiMajorUsageRow => ({
  usageDay: '2026-10-28',
  major: 1,
  organizationId: 'org_a',
  requestCount: 3,
  failureCount: 1,
  lastSeenAt: new Date('2026-10-28T10:00:00Z'),
  ...overrides,
});

describe('PostgresPublicApiMajorUsageRepository', () => {
  it('adds counts to the same day, major, and Organization and keeps the latest sighting', async () => {
    await repository.add('production', [row()]);
    await repository.add('production', [
      row({
        requestCount: 2,
        failureCount: 0,
        lastSeenAt: new Date('2026-10-28T09:00:00Z'),
      }),
    ]);

    const { rows } = await pool.query(
      `SELECT request_count::int AS requests, failure_count::int AS failures,
              last_seen_at
       FROM public_api_major_usage`,
    );
    expect(rows).toEqual([
      {
        requests: 5,
        failures: 1,
        last_seen_at: new Date('2026-10-28T10:00:00Z'),
      },
    ]);
  });

  it('reports totals by major and Environment and Organizations inside the window', async () => {
    await repository.add('production', [
      row(),
      row({ organizationId: null, requestCount: 4, failureCount: 0 }),
      row({ usageDay: '2026-10-20', organizationId: 'org_b', requestCount: 9 }),
      row({
        usageDay: '2026-09-01',
        organizationId: 'org_c',
        requestCount: 50,
      }),
    ]);
    await repository.add('sandbox', [
      row({ requestCount: 1, failureCount: 0 }),
    ]);

    const snapshot = await repository.snapshot({
      fromDay: '2026-10-01',
      toDay: '2026-10-29',
    });

    expect(snapshot.coverageStartDay).toBe('2026-09-01');
    expect(
      [...snapshot.totals].sort((a, b) =>
        a.environment.localeCompare(b.environment),
      ),
    ).toEqual([
      {
        environment: 'production',
        major: 1,
        requestCount: 16,
        failureCount: 2,
        unattributedCount: 4,
      },
      {
        environment: 'sandbox',
        major: 1,
        requestCount: 1,
        failureCount: 0,
        unattributedCount: 0,
      },
    ]);
    expect(
      snapshot.organizations
        .filter((organization) => organization.environment === 'production')
        .map(({ organizationId, requestCount }) => ({
          organizationId,
          requestCount,
        }))
        .sort((a, b) => a.organizationId.localeCompare(b.organizationId)),
    ).toEqual([
      { organizationId: 'org_a', requestCount: 3 },
      { organizationId: 'org_b', requestCount: 9 },
    ]);
  });

  it('refuses a count that makes failures exceed requests', async () => {
    await expect(
      repository.add('production', [row({ failureCount: 9 })]),
    ).rejects.toThrow(/public_api_major_usage_counts_check/);
  });

  it('reports no coverage when nothing was recorded', async () => {
    await expect(
      repository.snapshot({ fromDay: '2026-10-01', toDay: '2026-10-29' }),
    ).resolves.toEqual({
      coverageStartDay: undefined,
      totals: [],
      organizations: [],
    });
  });
});
