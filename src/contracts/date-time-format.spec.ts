import { isDateTime } from './date-time-format';

describe('isDateTime', () => {
  it.each([
    '2026-10-17T02:00:00Z',
    '2026-10-17T09:00:00.123+07:00',
    '2028-02-29T23:59:59Z',
  ])('accepts %s', (value) => {
    expect(isDateTime(value)).toBe(true);
  });

  it.each([
    ['a day past the end of February', '2026-02-30T00:00:00Z'],
    ['February 29 outside a leap year', '2027-02-29T00:00:00Z'],
    ['a day past the end of April', '2026-04-31T00:00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['a date without a time', '2026-10-17'],
    ['a timestamp without an offset', '2026-10-17T02:00:00'],
  ])('refuses %s', (_label, value) => {
    expect(isDateTime(value)).toBe(false);
  });
});
