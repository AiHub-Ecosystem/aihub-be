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
      callerKind: 'api-key',
      at: at('2026-10-28T23:59:59Z'),
    });
    buffer.record({
      major: 1,
      organizationId: 'org_a',
      failed: true,
      callerKind: 'api-key',
      at: at('2026-10-28T10:00:00Z'),
    });
    buffer.record({
      major: 1,
      organizationId: 'org_a',
      failed: false,
      callerKind: 'api-key',
      at: at('2026-10-29T00:00:00Z'),
    });
    buffer.record({
      major: 2,
      failed: false,
      callerKind: 'bearer',
      at: at('2026-10-28T12:00:00Z'),
    });

    expect(buffer.drain(at('2026-10-29T00:00:00Z')).rows).toEqual([
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

  it('empties on drain', () => {
    const buffer = new PublicApiMajorUsageBuffer();
    buffer.record({
      major: 1,
      failed: false,
      callerKind: 'none',
      at: at('2026-10-28T10:00:00Z'),
    });

    expect(buffer.drain(at('2026-10-28T10:01:00Z')).rows).toHaveLength(1);
    expect(buffer.drain(at('2026-10-28T10:02:00Z'))).toEqual({
      rows: [],
      unattributed: [],
      dropped: null,
    });
  });

  it('bounds both maps together, keeps retained keys collecting, and records the loss interval', () => {
    let drops = 0;
    const buffer = new PublicApiMajorUsageBuffer(() => {
      drops += 1;
    });
    const sample = (organizationId: string, at = '2026-10-28T10:00:00Z') =>
      buffer.record({
        major: 1,
        organizationId,
        failed: false,
        callerKind: 'api-key',
        at: new Date(at),
      });

    for (let i = 0; i < 16_382; i += 1) {
      sample(`org_${i}`);
    }
    buffer.record({
      major: 1,
      failed: false,
      callerKind: 'bearer',
      at: at('2026-10-28T10:00:00Z'),
    });
    sample('org_0', '2026-10-28T10:01:00Z');
    sample('org_overflow', '2026-10-28T10:01:00Z');
    buffer.record({
      major: 2,
      failed: false,
      callerKind: 'bearer',
      at: at('2026-10-28T10:02:00Z'),
    });

    const drained = buffer.drain(at('2026-10-28T10:03:00Z'));
    expect(drained.rows).toHaveLength(16_383);
    expect(drained.unattributed).toHaveLength(1);
    expect(drained.rows[0]?.requestCount).toBe(2);
    expect(drained.dropped).toEqual({
      from: at('2026-10-28T10:01:00Z'),
      through: at('2026-10-28T10:03:00Z'),
    });
    expect(drops).toBe(2);

    sample('org_after_drain');
    expect(buffer.drain(at('2026-10-28T10:04:00Z'))).toMatchObject({
      rows: [expect.objectContaining({ organizationId: 'org_after_drain' })],
      dropped: null,
    });
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

describe('PublicApiMajorUsageBuffer unattributed breakdown', () => {
  it('counts unattributed requests by caller kind and leaves attributed ones out', () => {
    const buffer = new PublicApiMajorUsageBuffer();
    const unattributed = (callerKind: 'bearer' | 'api-key', failed: boolean) =>
      buffer.record({
        major: 1,
        failed,
        callerKind,
        at: at('2026-10-28T10:00:00Z'),
      });
    unattributed('bearer', false);
    unattributed('bearer', true);
    unattributed('api-key', true);
    buffer.record({
      major: 1,
      organizationId: 'org_a',
      failed: false,
      callerKind: 'api-key',
      at: at('2026-10-28T10:00:00Z'),
    });

    expect(buffer.drain(at('2026-10-28T10:01:00Z')).unattributed).toEqual([
      {
        usageDay: '2026-10-28',
        major: 1,
        callerKind: 'bearer',
        requestCount: 2,
        failureCount: 1,
      },
      {
        usageDay: '2026-10-28',
        major: 1,
        callerKind: 'api-key',
        requestCount: 1,
        failureCount: 1,
      },
    ]);
  });
});

describe('buildPublicApiMajorReport', () => {
  const WINDOW = { fromDay: '2026-10-01', toDay: '2026-10-29' };
  const AS_OF = at('2026-10-28T12:00:00Z');
  const TOTAL = {
    environment: 'production',
    major: 1,
    requestCount: 10,
    failureCount: 2,
    unattributedCount: 3,
    unattributedFailureCount: 1,
  };
  const COLLECTOR = {
    environment: 'production',
    startedAt: at('2026-09-30T00:00:00Z'),
    coveredThrough: at('2026-10-28T11:59:40Z'),
    stoppedCleanlyAt: null,
  };

  it('groups totals by major and Environment and lists Organizations per major', () => {
    const report = buildPublicApiMajorReport({
      window: WINDOW,
      environment: 'production',
      asOf: AS_OF,
      coverageStartDay: '2026-10-05',
      totals: [TOTAL],
      organizations: [
        {
          environment: 'production',
          major: 1,
          organizationId: 'org_a',
          requestCount: 7,
          lastSeenAt: at('2026-10-28T10:00:00Z'),
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
      collectors: [COLLECTOR],
      droppedIntervals: [],
    });

    expect(report).toEqual({
      window: WINDOW,
      asOf: AS_OF,
      coverageStartDay: '2026-10-05',
      coverage: [
        {
          environment: 'production',
          verdict: 'complete',
          inconclusiveDays: [],
          uncleanExitDays: [],
        },
      ],
      majors: [
        {
          environment: 'production',
          major: 1,
          requestCount: 10,
          failureCount: 2,
          unattributedCount: 3,
          unattributed: [
            { callerKind: 'bearer', requestCount: 3, failureCount: 1 },
          ],
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

  it('reports unattributed counts a release without the breakdown wrote as unclassified', () => {
    const report = buildPublicApiMajorReport({
      window: WINDOW,
      environment: 'production',
      asOf: AS_OF,
      coverageStartDay: undefined,
      totals: [TOTAL],
      organizations: [],
      unattributed: [
        {
          environment: 'production',
          major: 1,
          callerKind: 'api-key',
          requestCount: 1,
          failureCount: 1,
        },
      ],
      collectors: [COLLECTOR],
      droppedIntervals: [],
    });

    expect(report.majors[0]?.unattributed).toEqual([
      { callerKind: 'api-key', requestCount: 1, failureCount: 1 },
      { callerKind: 'unclassified', requestCount: 2, failureCount: 0 },
    ]);
  });

  it('marks only the Environment and days of a dropped interval inconclusive', () => {
    const report = buildPublicApiMajorReport({
      window: WINDOW,
      environment: 'production',
      asOf: AS_OF,
      coverageStartDay: undefined,
      totals: [TOTAL, { ...TOTAL, environment: 'sandbox' }],
      organizations: [],
      unattributed: [],
      collectors: [COLLECTOR, { ...COLLECTOR, environment: 'sandbox' }],
      droppedIntervals: [
        {
          environment: 'production',
          droppedFrom: at('2026-10-10T23:59:50Z'),
          droppedThrough: at('2026-10-11T00:00:10Z'),
        },
      ],
    });

    expect(report.coverage).toEqual([
      {
        environment: 'production',
        verdict: 'inconclusive',
        inconclusiveDays: ['2026-10-10', '2026-10-11'],
        uncleanExitDays: [],
      },
      {
        environment: 'sandbox',
        verdict: 'complete',
        inconclusiveDays: [],
        uncleanExitDays: [],
      },
    ]);
  });

  it('judges an Environment with counts but no collection record inconclusive', () => {
    const report = buildPublicApiMajorReport({
      window: { fromDay: '2026-10-27', toDay: '2026-10-29' },
      asOf: AS_OF,
      coverageStartDay: undefined,
      environment: 'sandbox',
      totals: [{ ...TOTAL, environment: 'sandbox' }],
      organizations: [],
      unattributed: [],
      collectors: [],
      droppedIntervals: [],
    });

    expect(report.coverage).toEqual([
      {
        environment: 'sandbox',
        verdict: 'inconclusive',
        inconclusiveDays: ['2026-10-27', '2026-10-28'],
        uncleanExitDays: [],
      },
    ]);
    expect(report.majors[0]?.organizations).toEqual([]);
  });

  it('judges the database Environment inconclusive when nothing was recorded', () => {
    const report = buildPublicApiMajorReport({
      window: { fromDay: '2026-10-27', toDay: '2026-10-29' },
      environment: 'production',
      asOf: AS_OF,
      coverageStartDay: undefined,
      totals: [],
      organizations: [],
      unattributed: [],
      collectors: [],
      droppedIntervals: [],
    });

    expect(report.coverage).toEqual([
      {
        environment: 'production',
        verdict: 'inconclusive',
        inconclusiveDays: ['2026-10-27', '2026-10-28'],
        uncleanExitDays: [],
      },
    ]);
    expect(report.majors).toEqual([]);
  });
});
