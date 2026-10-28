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
      coverageStartDay: '2026-10-05',
      totals: [
        {
          environment: 'production',
          major: 1,
          requestCount: 10,
          failureCount: 2,
          unattributedCount: 3,
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
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('public API major report CLI boundary', () => {
  it('emits one JSONL line per major and Organization, then a window line', async () => {
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
        event: 'public_api_major_window',
        window_from: '2026-10-01',
        window_to: '2026-10-29',
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
