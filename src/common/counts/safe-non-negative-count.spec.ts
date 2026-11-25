import { safeNonNegativeCount } from './safe-non-negative-count';

describe('safeNonNegativeCount', () => {
  it('decodes whole counts from bigint, number, and decimal string', () => {
    expect(safeNonNegativeCount(0n)).toBe(0);
    expect(safeNonNegativeCount(42n)).toBe(42);
    expect(safeNonNegativeCount(7)).toBe(7);
    expect(safeNonNegativeCount('0')).toBe(0);
    expect(safeNonNegativeCount('123')).toBe(123);
  });

  it('refuses negative, fractional, padded, unsafe, and non-numeric values', () => {
    const refused: readonly unknown[] = [
      -1,
      -1n,
      '-1',
      1.5,
      '01',
      '',
      null,
      undefined,
      Number.MAX_SAFE_INTEGER + 1,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    ];
    for (const value of refused) {
      expect(safeNonNegativeCount(value)).toBeUndefined();
    }
  });
});
