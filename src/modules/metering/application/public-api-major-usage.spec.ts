import {
  PublicApiMajorUsageBuffer,
  PublicApiMajorUsageError,
  buildPublicApiMajorReport,
  parsePublicApiMajorWindow,
} from './public-api-major-usage';

const at = (iso: string): Date => new Date(iso);

describe('PublicApiMajorUsageBuffer', () => {
  it('folds samples into one row per UTC day, major, and Organization', () => {
    const buffer = new PublicApiMajorUsageBuffer();
    buffer.record({
      major: 1,
      organizationId: 'org_a',
      failed: false,
      at: at('2026-10-28T23:59:59Z'),
    });
    buffer.record({
      major: 1,
      organizationId: 'org_a',
      failed: true,
      at: at('2026-10-28T10:00:00Z'),
    });
    buffer.record({
      major: 1,
      organizationId: 'org_a',
      failed: false,
      at: at('2026-10-29T00:00:00Z'),
    });
    buffer.record({ major: 2, failed: false, at: at('2026-10-28T12:00:00Z') });

    expect(buffer.drain()).toEqual([
      {
        usageDay: '2026-10-28',
        major: 1,
        organizationId: 'org_a',
        requestCount: 2,
        failureCount: 1,
        lastSeenAt: at('2026-10-28T23:59:59Z'),
      },
      {
        usageDay: '2026-10-29',
        major: 1,
        organizationId: 'org_a',
        requestCount: 1,
        failureCount: 0,
        lastSeenAt: at('2026-10-29T00:00:00Z'),
      },
      {
        usageDay: '2026-10-28',
        major: 2,
        organizationId: null,
        requestCount: 1,
        failureCount: 0,
        lastSeenAt: at('2026-10-28T12:00:00Z'),
      },
    ]);
  });

  it('empties on drain and merges restored rows back in', () => {
    const buffer = new PublicApiMajorUsageBuffer();
    buffer.record({ major: 1, failed: false, at: at('2026-10-28T10:00:00Z') });
    const drained = buffer.drain();
    expect(buffer.drain()).toEqual([]);

    buffer.record({ major: 1, failed: true, at: at('2026-10-28T11:00:00Z') });
    buffer.restore(drained);

    expect(buffer.drain()).toEqual([
      {
        usageDay: '2026-10-28',
        major: 1,
        organizationId: null,
        requestCount: 2,
        failureCount: 1,
        lastSeenAt: at('2026-10-28T11:00:00Z'),
      },
    ]);
  });
});

describe('parsePublicApiMajorWindow', () => {
  const now = at('2026-10-28T13:00:00Z');

  it('reads UTC days with an exclusive end', () => {
    expect(parsePublicApiMajorWindow('2026-10-01', '2026-10-29', now)).toEqual({
      fromDay: '2026-10-01',
      toDay: '2026-10-29',
    });
  });

  it.each([
    ['2026-10-29', '2026-10-01'],
    ['2026-10-01', '2026-10-01'],
    ['2026-10-01', '2026-10-30'],
    ['2026-02-30', '2026-03-01'],
    ['2026-10-01T00:00:00Z', '2026-10-02'],
    ['yesterday', '2026-10-02'],
  ])('refuses %s to %s', (from, to) => {
    expect(() => parsePublicApiMajorWindow(from, to, now)).toThrow(
      PublicApiMajorUsageError,
    );
  });
});

describe('buildPublicApiMajorReport', () => {
  it('groups totals by major and Environment and lists Organizations per major', () => {
    const report = buildPublicApiMajorReport({
      window: { fromDay: '2026-10-01', toDay: '2026-10-29' },
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
          lastSeenAt: at('2026-10-28T10:00:00Z'),
        },
      ],
    });

    expect(report).toEqual({
      window: { fromDay: '2026-10-01', toDay: '2026-10-29' },
      coverageStartDay: '2026-10-05',
      majors: [
        {
          environment: 'production',
          major: 1,
          requestCount: 10,
          failureCount: 2,
          unattributedCount: 3,
          organizations: [
            {
              organizationId: 'org_a',
              requestCount: 7,
              lastSeenAt: at('2026-10-28T10:00:00Z'),
            },
          ],
        },
      ],
    });
  });

  it('keeps a major with traffic but no attributed Organization', () => {
    const report = buildPublicApiMajorReport({
      window: { fromDay: '2026-10-01', toDay: '2026-10-29' },
      coverageStartDay: undefined,
      totals: [
        {
          environment: 'sandbox',
          major: 1,
          requestCount: 4,
          failureCount: 0,
          unattributedCount: 4,
        },
      ],
      organizations: [],
    });

    expect(report.majors[0]?.organizations).toEqual([]);
    expect(report.coverageStartDay).toBeUndefined();
  });
});
