import { parseQuotaMonth, quotaMonth, quotaPeriod } from './quota-period';

describe('quotaPeriod', () => {
  it('answers the whole question for a mid-month instant', () => {
    expect(quotaPeriod(new Date('2026-09-16T12:00:00.000Z'))).toEqual({
      year: 2026,
      monthIndex: 8,
      key: '2026-09',
      monthNumber: 202609,
      start: new Date('2026-09-01T00:00:00.000Z'),
      end: new Date('2026-10-01T00:00:00.000Z'),
      retryAfterMs: 1_252_800_000,
    });
  });

  // The boundary is the thing five call sites each used to derive, so the two
  // instants on either side of it are the cases that can disagree.
  it('keeps the last millisecond of a month inside that month', () => {
    const period = quotaPeriod(new Date('2026-09-30T23:59:59.999Z'));

    expect(period.key).toBe('2026-09');
    expect(period.end).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect(period.retryAfterMs).toBe(1);
  });

  it('starts the next month on its first millisecond', () => {
    const period = quotaPeriod(new Date('2026-10-01T00:00:00.000Z'));

    expect(period.key).toBe('2026-10');
    expect(period.monthNumber).toBe(202610);
    expect(period.start).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect(period.retryAfterMs).toBe(31 * 24 * 60 * 60 * 1000);
  });

  // December is the only month whose number has to carry into the next year.
  it('rolls December into January', () => {
    const december = quotaPeriod(new Date('2026-12-31T23:59:59.999Z'));

    expect(december.key).toBe('2026-12');
    expect(december.monthNumber).toBe(202612);
    expect(december.end).toEqual(new Date('2027-01-01T00:00:00.000Z'));
    expect(december.retryAfterMs).toBe(1);

    const january = quotaPeriod(new Date('2027-01-01T00:00:00.000Z'));

    expect(january.key).toBe('2027-01');
    expect(january.monthNumber).toBe(202701);
    expect(january.start).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });

  it('gives an instant at either end of a leap February the same month', () => {
    expect(quotaPeriod(new Date('2028-02-29T23:59:59.999Z')).key).toBe(
      '2028-02',
    );
    expect(quotaPeriod(new Date('2028-02-01T00:00:00.000Z')).end).toEqual(
      new Date('2028-03-01T00:00:00.000Z'),
    );
  });
});

describe('quotaMonth', () => {
  it('builds the same period from a stated year and month', () => {
    const period = quotaMonth(2026, 8);

    expect(period.key).toBe('2026-09');
    expect(period.monthNumber).toBe(202609);
    expect(period.start).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(period.end).toEqual(new Date('2026-10-01T00:00:00.000Z'));
  });

  it('carries a December window into the next year', () => {
    expect(quotaMonth(2026, 11).end).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    );
  });
});

describe('parseQuotaMonth', () => {
  it('reads a valid label into the period it names', () => {
    expect(parseQuotaMonth('2026-09')).toEqual({
      year: 2026,
      monthIndex: 8,
      key: '2026-09',
      monthNumber: 202609,
      start: new Date('2026-09-01T00:00:00.000Z'),
      end: new Date('2026-10-01T00:00:00.000Z'),
    });
  });

  it('reads December and carries the window into January', () => {
    expect(parseQuotaMonth('2026-12')?.end).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    );
  });

  it('returns undefined for a malformed label', () => {
    expect(parseQuotaMonth('2026-7')).toBeUndefined();
    expect(parseQuotaMonth('2026-13')).toBeUndefined();
    expect(parseQuotaMonth('10-2026')).toBeUndefined();
    expect(parseQuotaMonth('')).toBeUndefined();
    expect(parseQuotaMonth('202609')).toBeUndefined();
  });

  it('does not trim, so the caller owns strictness', () => {
    expect(parseQuotaMonth(' 2026-09')).toBeUndefined();
    expect(parseQuotaMonth('2026-09 ')).toBeUndefined();
  });
});
