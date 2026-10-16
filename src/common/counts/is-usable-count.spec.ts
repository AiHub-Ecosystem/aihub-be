import { isUsableCount } from './is-usable-count';

/**
 * A count here is a quota counter, a request tally, or a token tally: a whole
 * number that a report or an admission decision adds up. The admission guard
 * reads it, reconciliation overwrites it, and the finalizer writes it, so the
 * decision cannot depend on which of them is looking.
 */
describe('isUsableCount', () => {
  it('accepts zero, because a counter that has not been used yet is a real count', () => {
    expect(isUsableCount(0)).toBe(true);
  });

  it('accepts a positive whole number', () => {
    expect(isUsableCount(1)).toBe(true);
    expect(isUsableCount(4_096)).toBe(true);
  });

  // The last value a double can still tell apart from its neighbour. A tally
  // above this cannot be represented exactly, so no sum of such tallies is
  // trustworthy either.
  it('accepts the largest exactly representable integer', () => {
    expect(isUsableCount(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  // This is the boundary the lenient copies got wrong: `Number.isInteger` calls
  // it an integer, and a counter the admission guard accepted could then be
  // refused when reconciliation read it back.
  it('refuses the first integer above it', () => {
    expect(isUsableCount(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it('refuses a negative count', () => {
    expect(isUsableCount(-1)).toBe(false);
  });

  it('refuses a fraction', () => {
    expect(isUsableCount(1.5)).toBe(false);
  });

  it('refuses the values that are numbers but not counts', () => {
    expect(isUsableCount(Number.NaN)).toBe(false);
    expect(isUsableCount(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isUsableCount(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('refuses everything that is not a number, including a numeric string', () => {
    for (const value of [
      undefined,
      null,
      '5',
      '',
      true,
      false,
      [],
      {},
      new Date(),
    ]) {
      expect(isUsableCount(value)).toBe(false);
    }
  });
});
