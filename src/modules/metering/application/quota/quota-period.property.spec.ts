import * as fc from 'fast-check';

import { PROPERTY_OPTIONS } from '../../../../../test/support/property-options';
import { parseQuotaMonth, quotaMonth, quotaPeriod } from './quota-period';

const instantArbitrary = fc.date({
  min: new Date('1970-01-01T00:00:00.000Z'),
  max: new Date('2200-12-31T23:59:59.999Z'),
});

const MAX_MONTH_MS = 31 * 24 * 60 * 60 * 1000;

describe('quotaPeriod properties', () => {
  it('puts every instant inside a period that starts and ends on UTC month edges', () => {
    fc.assert(
      fc.property(instantArbitrary, (now) => {
        const { start, end, retryAfterMs } = quotaPeriod(now);

        expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(now.getTime()).toBeLessThan(end.getTime());
        for (const edge of [start, end]) {
          expect(edge.getUTCDate()).toBe(1);
          expect(edge.getUTCHours()).toBe(0);
          expect(edge.getUTCMinutes()).toBe(0);
          expect(edge.getUTCSeconds()).toBe(0);
          expect(edge.getUTCMilliseconds()).toBe(0);
        }
        expect(retryAfterMs).toBe(end.getTime() - now.getTime());
        expect(retryAfterMs).toBeGreaterThan(0);
        expect(retryAfterMs).toBeLessThanOrEqual(MAX_MONTH_MS);
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('starts a new count at the first millisecond of the next month, and not before', () => {
    fc.assert(
      fc.property(instantArbitrary, (now) => {
        const period = quotaPeriod(now);

        expect(quotaPeriod(period.start).key).toBe(period.key);
        expect(quotaPeriod(new Date(period.end.getTime() - 1)).key).toBe(
          period.key,
        );
        expect(quotaPeriod(period.end).key).not.toBe(period.key);
        expect(quotaPeriod(period.end).start).toEqual(period.end);
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('labels the month YYYY-MM and YYYYMM consistently, and parses the label back', () => {
    fc.assert(
      fc.property(instantArbitrary, (now) => {
        const { key, monthNumber, year, monthIndex } = quotaPeriod(now);

        expect(key).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
        expect(monthNumber).toBe(Number(key.replace('-', '')));
        expect(parseQuotaMonth(key)).toEqual(quotaMonth(year, monthIndex));
      }),
      PROPERTY_OPTIONS,
    );
  });
});
