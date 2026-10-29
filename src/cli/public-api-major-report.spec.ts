import type {
  PublicApiMajorUsageRepositoryPort,
  PublicApiMajorWindow,
} from '@/modules/metering/public/public-api-major-usage';
import { runPublicApiMajorReportCommand } from './public-api-major-report';

const now = new Date('2026-10-28T13:00:00.000Z');

class FakeRepository implements PublicApiMajorUsageRepositoryPort {
  readonly windows: PublicApiMajorWindow[] = [];
  closed = false;

  async add(): Promise<void> {
    throw new Error('not used');
  }

  async snapshot(window: PublicApiMajorWindow) {
    this.windows.push(window);
    return {
      asOf: new Date('2026-10-28T12:59:00.000Z'),
      coverageStartDay: '2026-10-05',
      totals: [
        {
          environment: 'production',
          major: 1,
          requestCount: 10,
          failureCount: 2,
          unattributedCount: 3,
          unattributedFailureCount: 1,
        },
      ],
      organizations: [
        {
          environment: 'production',
          major: 1,
          organizationId: 'org_a',
          requestCount: 7,
          lastSeenAt: new Date('2026-10-28T10:00:00.000Z'),
        },
      ],
      unattributed: [
        {
          environment: 'production',
          major: 1,
          callerKind: 'bearer',
          requestCount: 3,
          failureCount: 1,
        },
      ],
      collectors: [
        {
          environment: 'production',
          startedAt: new Date('2026-10-20T08:00:00.000Z'),
          coveredThrough: new Date('2026-10-28T12:58:40.000Z'),
          stoppedCleanlyAt: null,
        },
      ],
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('public API major report CLI boundary', () => {
  it('emits lines per major, caller kind, and Organization, then coverage and window lines', async () => {
    const lines: string[] = [];
    const repository = new FakeRepository();

    await runPublicApiMajorReportCommand({
      databaseUrl: 'postgres://test',
      from: '2026-10-01',
      to: '2026-10-29',
      now,
      repository,
      emit: (line) => lines.push(line),
    });

    expect(repository.windows).toEqual([
      { fromDay: '2026-10-01', toDay: '2026-10-29' },
    ]);
    expect(repository.closed).toBe(true);
    expect(lines.map((line): unknown => JSON.parse(line))).toEqual([
      {
        event: 'public_api_major_total',
        window_from: '2026-10-01',
        window_to: '2026-10-29',
        environment: 'production',
        major: 1,
        request_count: 10,
        failure_count: 2,
        unattributed_count: 3,
        organization_count: 1,
      },
      {
        event: 'public_api_major_unattributed',
        window_from: '2026-10-01',
        window_to: '2026-10-29',
        environment: 'production',
        major: 1,
        caller_kind: 'bearer',
        request_count: 3,
        failure_count: 1,
      },
      {
        event: 'public_api_major_organization',
        window_from: '2026-10-01',
        window_to: '2026-10-29',
        environment: 'production',
        major: 1,
        organization_id: 'org_a',
        request_count: 7,
        last_seen_at: '2026-10-28T10:00:00.000Z',
      },
      {
        event: 'public_api_major_coverage',
        window_from: '2026-10-01',
        window_to: '2026-10-29',
        environment: 'production',
        verdict: 'inconclusive',
        inconclusive_days: [
          '2026-10-01',
          '2026-10-02',
          '2026-10-03',
          '2026-10-04',
          '2026-10-05',
          '2026-10-06',
          '2026-10-07',
          '2026-10-08',
          '2026-10-09',
          '2026-10-10',
          '2026-10-11',
          '2026-10-12',
          '2026-10-13',
          '2026-10-14',
          '2026-10-15',
          '2026-10-16',
          '2026-10-17',
          '2026-10-18',
          '2026-10-19',
          '2026-10-20',
        ],
        unclean_exits: [],
      },
      {
        event: 'public_api_major_window',
        window_from: '2026-10-01',
        window_to: '2026-10-29',
        as_of: '2026-10-28T12:59:00.000Z',
        coverage_start_day: '2026-10-05',
        majors: 1,
      },
    ]);
  });

  it('refuses an invalid window before reading anything', async () => {
    const repository = new FakeRepository();

    await expect(
      runPublicApiMajorReportCommand({
        databaseUrl: 'postgres://test',
        from: '2026-10-29',
        to: '2026-10-01',
        now,
        repository,
        emit: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'PUBLIC_API_MAJOR_REPORT_INVALID_WINDOW',
    });
    expect(repository.windows).toEqual([]);
  });

  it('reports a database failure without its detail', async () => {
    const lines: string[] = [];
    const failing: PublicApiMajorUsageRepositoryPort = {
      add: async () => undefined,
      snapshot: async () => {
        throw new Error('connect ECONNREFUSED postgres://u:secret@host/db');
      },
    };

    await expect(
      runPublicApiMajorReportCommand({
        databaseUrl: 'postgres://test',
        from: '2026-10-01',
        to: '2026-10-29',
        now,
        repository: failing,
        emit: (line) => lines.push(line),
      }),
    ).rejects.toMatchObject({
      code: 'PUBLIC_API_MAJOR_REPORT_DATABASE_FAILURE',
    });
    expect(lines.join('\n')).not.toContain('secret');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      event: 'public_api_major_report_failed',
      error_code: 'PUBLIC_API_MAJOR_REPORT_DATABASE_FAILURE',
    });
  });
});
