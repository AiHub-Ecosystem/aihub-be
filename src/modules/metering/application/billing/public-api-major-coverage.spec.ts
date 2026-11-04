import { assessPublicApiMajorCoverage } from './public-api-major-coverage';

const at = (iso: string): Date => new Date(iso);
const WINDOW = { fromDay: '2026-10-01', toDay: '2026-10-04' };

function collector(
  startedAt: string,
  coveredThrough: string,
  stoppedCleanlyAt: string | null = coveredThrough,
) {
  return {
    environment: 'production',
    startedAt: at(startedAt),
    coveredThrough: at(coveredThrough),
    stoppedCleanlyAt: stoppedCleanlyAt === null ? null : at(stoppedCleanlyAt),
  };
}

function assess(
  collectors: ReturnType<typeof collector>[],
  asOf = '2026-10-04T00:00:00Z',
  droppedIntervals: {
    environment: string;
    droppedFrom: Date;
    droppedThrough: Date;
  }[] = [],
) {
  return assessPublicApiMajorCoverage({
    environment: 'production',
    window: WINDOW,
    asOf: at(asOf),
    collectors,
    droppedIntervals,
  });
}

describe('assessPublicApiMajorCoverage', () => {
  it('is complete when collection covers the whole window', () => {
    expect(
      assess([collector('2026-09-30T00:00:00Z', '2026-10-04T00:00:00Z')]),
    ).toEqual({
      environment: 'production',
      verdict: 'complete',
      inconclusiveDays: [],
      uncleanExitDays: [],
    });
  });

  it('joins processes that overlap during a blue-green deploy', () => {
    expect(
      assess([
        collector('2026-09-30T00:00:00Z', '2026-10-02T12:00:30Z'),
        collector('2026-10-02T12:00:00Z', '2026-10-04T00:00:00Z'),
      ]).verdict,
    ).toBe('complete');
  });

  it('tolerates the gap an unclean exit leaves when a replacement starts within five minutes, and reports the exit', () => {
    expect(
      assess([
        collector('2026-09-30T00:00:00Z', '2026-10-02T12:00:00Z', null),
        collector('2026-10-02T12:04:59Z', '2026-10-04T00:00:00Z'),
      ]),
    ).toEqual({
      environment: 'production',
      verdict: 'complete',
      inconclusiveDays: [],
      uncleanExitDays: ['2026-10-02'],
    });
  });

  it('marks every UTC day a longer gap touches as inconclusive', () => {
    expect(
      assess([
        collector('2026-09-30T00:00:00Z', '2026-10-01T23:58:00Z', null),
        collector('2026-10-02T00:10:00Z', '2026-10-04T00:00:00Z'),
      ]),
    ).toMatchObject({
      verdict: 'inconclusive',
      inconclusiveDays: ['2026-10-01', '2026-10-02'],
    });
  });

  it('treats days before the first collection record as inconclusive', () => {
    expect(
      assess([collector('2026-10-02T08:00:00Z', '2026-10-04T00:00:00Z')])
        .inconclusiveDays,
    ).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('is inconclusive for every window day when nothing was ever collected', () => {
    expect(assess([]).inconclusiveDays).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
  });

  it('does not count the tail before a running process next flushes', () => {
    expect(
      assess(
        [collector('2026-09-30T00:00:00Z', '2026-10-03T11:56:00Z', null)],
        '2026-10-03T12:00:00Z',
      ),
    ).toEqual({
      environment: 'production',
      verdict: 'complete',
      inconclusiveDays: [],
      uncleanExitDays: [],
    });
  });

  it('marks today inconclusive once the latest process has gone quiet for longer', () => {
    expect(
      assess(
        [collector('2026-09-30T00:00:00Z', '2026-10-03T11:00:00Z', null)],
        '2026-10-03T12:00:00Z',
      ),
    ).toEqual({
      environment: 'production',
      verdict: 'inconclusive',
      inconclusiveDays: ['2026-10-03'],
      uncleanExitDays: ['2026-10-03'],
    });
  });

  it('ignores collection outside the window', () => {
    expect(
      assess([
        collector('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', null),
        collector('2026-09-30T00:00:00Z', '2026-10-04T00:00:00Z'),
      ]),
    ).toMatchObject({ verdict: 'complete', uncleanExitDays: [] });
  });

  it('marks dropped-sample days inconclusive and reports complete days after recovery', () => {
    expect(
      assess(
        [collector('2026-09-30T00:00:00Z', '2026-10-05T00:00:00Z')],
        '2026-10-05T00:00:00Z',
        [
          {
            environment: 'production',
            droppedFrom: at('2026-10-02T23:59:00Z'),
            droppedThrough: at('2026-10-03T00:01:00Z'),
          },
        ],
      ),
    ).toEqual({
      environment: 'production',
      verdict: 'inconclusive',
      inconclusiveDays: ['2026-10-02', '2026-10-03'],
      uncleanExitDays: [],
    });
  });

  it('marks the day of a point loss interval inconclusive', () => {
    expect(
      assess(
        [collector('2026-09-30T00:00:00Z', '2026-10-04T00:00:00Z')],
        '2026-10-04T00:00:00Z',
        [
          {
            environment: 'production',
            droppedFrom: at('2026-10-02T12:00:00Z'),
            droppedThrough: at('2026-10-02T12:00:00Z'),
          },
        ],
      ),
    ).toMatchObject({
      verdict: 'inconclusive',
      inconclusiveDays: ['2026-10-02'],
    });
  });
});
