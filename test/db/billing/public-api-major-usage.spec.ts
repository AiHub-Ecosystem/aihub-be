import type { Pool } from 'pg';

import type {
  PublicApiMajorUsageRow,
  PublicApiMajorUsageWrite,
} from '@/modules/metering/application/public-api-major-usage';
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
  await pool.query(
    'TRUNCATE public_api_major_usage, public_api_major_unattributed_usage, public_api_major_usage_coverage, public_api_major_usage_dropped_interval',
  );
});

const PROCESS = {
  processId: '0f8a4c2e-6b1d-4e3f-9a57-2c1d0e9b8a76',
  startedAt: new Date('2026-10-28T08:00:00Z'),
};

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

// Each write is the process's next one, as the flusher numbers them.
let batches = 0;
beforeEach(() => {
  batches = 0;
});

const write = (
  rows: readonly PublicApiMajorUsageRow[],
  overrides: Partial<PublicApiMajorUsageWrite> = {},
): PublicApiMajorUsageWrite => ({
  rows,
  unattributed: [],
  collector: PROCESS,
  batch: ++batches,
  coveredThrough: new Date('2026-10-28T10:00:30Z'),
  stoppedCleanly: false,
  droppedFrom: null,
  droppedThrough: null,
  ...overrides,
});

async function coverageRows(): Promise<unknown[]> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT process_id, environment, started_at, covered_through, stopped_cleanly_at
     FROM public_api_major_usage_coverage`,
  );
  return rows;
}

describe('PostgresPublicApiMajorUsageRepository', () => {
  it('adds counts to the same day, major, and Organization and keeps the latest sighting', async () => {
    await repository.add('production', write([row()]));
    await repository.add(
      'production',
      write([
        row({
          requestCount: 2,
          failureCount: 0,
          lastSeenAt: new Date('2026-10-28T09:00:00Z'),
        }),
      ]),
    );

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

  it('records the process collection with its counts, moves it forward only, and keeps a clean stop', async () => {
    await repository.add('production', write([row()]));
    await repository.add(
      'production',
      write([], { coveredThrough: new Date('2026-10-28T10:01:00Z') }),
    );
    await repository.add(
      'production',
      write([], { coveredThrough: new Date('2026-10-28T10:00:45Z') }),
    );

    expect(await coverageRows()).toEqual([
      {
        process_id: PROCESS.processId,
        environment: 'production',
        started_at: PROCESS.startedAt,
        covered_through: new Date('2026-10-28T10:01:00Z'),
        stopped_cleanly_at: null,
      },
    ]);

    await repository.add(
      'production',
      write([], {
        coveredThrough: new Date('2026-10-28T10:02:00Z'),
        stoppedCleanly: true,
      }),
    );

    expect(await coverageRows()).toMatchObject([
      { stopped_cleanly_at: new Date('2026-10-28T10:02:00Z') },
    ]);
  });

  it('adds a write retried after its commit response was lost only once', async () => {
    const unattributed = [
      {
        usageDay: '2026-10-28',
        major: 1,
        callerKind: 'none' as const,
        requestCount: 2,
        failureCount: 0,
      },
    ];
    const committed = write([row()], {
      unattributed,
      droppedFrom: new Date('2026-10-28T10:00:10Z'),
      droppedThrough: new Date('2026-10-28T10:00:30Z'),
    });
    await repository.add('production', committed);
    await repository.add('production', committed);
    await repository.add('production', write([row({ requestCount: 1 })]));

    const { rows } = await pool.query(
      `SELECT
         (SELECT request_count::int FROM public_api_major_usage) AS requests,
         (SELECT request_count::int FROM public_api_major_unattributed_usage)
           AS unattributed,
         (SELECT applied_batch::int FROM public_api_major_usage_coverage)
           AS applied_batch,
         (SELECT COUNT(*)::int FROM public_api_major_usage_dropped_interval)
           AS dropped_intervals`,
    );
    expect(rows).toEqual([
      { requests: 4, unattributed: 2, applied_batch: 2, dropped_intervals: 1 },
    ]);
  });

  it('writes neither the counts nor the collection when one part is refused', async () => {
    await expect(
      repository.add('production', write([row({ failureCount: 9 })])),
    ).rejects.toThrow(/public_api_major_usage_counts_check/);

    expect(await coverageRows()).toEqual([]);
  });

  it('adds unattributed counts by caller kind and accepts a kind this release does not know', async () => {
    const unattributed = [
      {
        usageDay: '2026-10-28',
        major: 1,
        callerKind: 'bearer' as const,
        requestCount: 2,
        failureCount: 1,
      },
    ];
    await repository.add('production', write([], { unattributed }));
    await repository.add('production', write([], { unattributed }));
    await pool.query(
      `INSERT INTO public_api_major_unattributed_usage
         (usage_day, environment, major, caller_kind, request_count, failure_count)
       VALUES ('2026-10-28', 'production', 1, 'mtls-client', 1, 0)`,
    );

    const { rows } = await pool.query(
      `SELECT caller_kind, request_count::int AS requests, failure_count::int AS failures
       FROM public_api_major_unattributed_usage ORDER BY caller_kind`,
    );
    expect(rows).toEqual([
      { caller_kind: 'bearer', requests: 4, failures: 2 },
      { caller_kind: 'mtls-client', requests: 1, failures: 0 },
    ]);
  });

  it('reads totals, Organizations, breakdown, and collection from one snapshot', async () => {
    await repository.add(
      'production',
      write(
        [
          row(),
          row({ organizationId: null, requestCount: 4, failureCount: 1 }),
          row({
            usageDay: '2026-10-20',
            organizationId: 'org_b',
            requestCount: 9,
          }),
          row({
            usageDay: '2026-09-01',
            organizationId: 'org_c',
            requestCount: 50,
          }),
        ],
        {
          unattributed: [
            {
              usageDay: '2026-10-28',
              major: 1,
              callerKind: 'api-key',
              requestCount: 4,
              failureCount: 1,
            },
          ],
          droppedFrom: new Date('2026-10-28T10:00:10Z'),
          droppedThrough: new Date('2026-10-28T10:00:30Z'),
        },
      ),
    );
    await repository.add(
      'sandbox',
      write([row({ requestCount: 1, failureCount: 0 })], {
        collector: {
          ...PROCESS,
          processId: 'a3c5e7f9-1b2d-4f60-8a9c-0e1f2a3b4c5d',
        },
      }),
    );

    const snapshot = await repository.snapshot({
      fromDay: '2026-10-01',
      toDay: '2026-10-29',
    });

    expect(snapshot.asOf).toBeInstanceOf(Date);
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
        failureCount: 3,
        unattributedCount: 4,
        unattributedFailureCount: 1,
      },
      {
        environment: 'sandbox',
        major: 1,
        requestCount: 1,
        failureCount: 0,
        unattributedCount: 0,
        unattributedFailureCount: 0,
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
    expect(snapshot.unattributed).toEqual([
      {
        environment: 'production',
        major: 1,
        callerKind: 'api-key',
        requestCount: 4,
        failureCount: 1,
      },
    ]);
    expect(
      snapshot.collectors.map((collector) => collector.environment).sort(),
    ).toEqual(['production', 'sandbox']);
    expect(snapshot.droppedIntervals).toEqual([
      {
        environment: 'production',
        droppedFrom: new Date('2026-10-28T10:00:10Z'),
        droppedThrough: new Date('2026-10-28T10:00:30Z'),
      },
    ]);
  });

  it('leaves out a process whose collection ended before the window', async () => {
    await repository.add('production', write([]));

    const snapshot = await repository.snapshot({
      fromDay: '2026-10-29',
      toDay: '2026-10-30',
    });

    expect(snapshot.collectors).toEqual([]);
  });

  it('reports nothing when nothing was recorded', async () => {
    await expect(
      repository.snapshot({ fromDay: '2026-10-01', toDay: '2026-10-29' }),
    ).resolves.toMatchObject({
      coverageStartDay: undefined,
      totals: [],
      organizations: [],
      unattributed: [],
      collectors: [],
      droppedIntervals: [],
    });
  });
});
