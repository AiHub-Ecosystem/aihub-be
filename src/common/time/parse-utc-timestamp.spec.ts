import { parseUtcTimestamp } from './parse-utc-timestamp';

describe('parseUtcTimestamp', () => {
  it('parses a canonical UTC instant', () => {
    expect(parseUtcTimestamp('2026-09-22T10:30:00Z')).toEqual(
      new Date('2026-09-22T10:30:00.000Z'),
    );
  });

  it('parses a fractional component shorter than three digits', () => {
    expect(parseUtcTimestamp('2026-09-22T10:30:00.5Z')).toEqual(
      new Date('2026-09-22T10:30:00.500Z'),
    );
  });

  it('parses a full millisecond component', () => {
    expect(parseUtcTimestamp('2026-09-22T10:30:00.123Z')).toEqual(
      new Date('2026-09-22T10:30:00.123Z'),
    );
  });

  /**
   * The platform rolls an impossible date forward instead of rejecting it, so
   * the round trip through `toISOString` is the only thing that catches this.
   */
  it('rejects a date that does not exist', () => {
    expect(parseUtcTimestamp('2026-02-30T00:00:00Z')).toBeUndefined();
  });

  it('rejects an out-of-range month and day', () => {
    expect(parseUtcTimestamp('2026-13-01T00:00:00Z')).toBeUndefined();
    expect(parseUtcTimestamp('2026-09-32T00:00:00Z')).toBeUndefined();
  });

  it('rejects an instant that is not UTC', () => {
    expect(parseUtcTimestamp('2026-09-22T10:30:00+07:00')).toBeUndefined();
    expect(parseUtcTimestamp('2026-09-22T10:30:00')).toBeUndefined();
  });

  it('rejects a value that is not a timestamp at all', () => {
    expect(parseUtcTimestamp('')).toBeUndefined();
    expect(parseUtcTimestamp('yesterday')).toBeUndefined();
    expect(parseUtcTimestamp('2026-09-22')).toBeUndefined();
  });

  it('reports failure by return value rather than by raising', () => {
    expect(() => parseUtcTimestamp('nonsense')).not.toThrow();
  });
});
