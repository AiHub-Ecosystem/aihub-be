import {
  asDate,
  asDateOrIso,
  booleanValue,
  dateValue,
  integerValue,
  nullableDateValue,
  nullableNonNegativeIntegerValue,
  nullableOneOf,
  nullableStringValue,
  oneOf,
  positiveIntegerValue,
  stringArrayValue,
  stringValue,
} from './row-readers';

const at = new Date('2026-10-27T00:00:00.000Z');

describe('row readers', () => {
  it('reads a Date as a copy and refuses a string or an invalid Date', () => {
    const read = asDate(at);

    expect(read).toEqual(at);
    expect(read).not.toBe(at);
    expect(asDate(at.toISOString())).toBeUndefined();
    expect(asDate(new Date('nope'))).toBeUndefined();
    expect(asDate(null)).toBeUndefined();
  });

  it('reads a Date or an ISO string when the column may arrive as text', () => {
    expect(asDateOrIso(at.toISOString())).toEqual(at);
    expect(asDateOrIso(at)).toEqual(at);
    expect(asDateOrIso('nope')).toBeUndefined();
    expect(asDateOrIso(5)).toBeUndefined();
  });

  it('tells SQL NULL from a malformed value', () => {
    expect(nullableDateValue({ d: null }, 'd')).toBeNull();
    expect(nullableDateValue({ d: at }, 'd')).toEqual(at);
    expect(nullableDateValue({}, 'd')).toBeUndefined();
    expect(nullableDateValue({ d: 'x' }, 'd')).toBeUndefined();
    expect(nullableStringValue({ s: null }, 's')).toBeNull();
    expect(nullableStringValue({ s: '' }, 's')).toBeUndefined();
    expect(nullableNonNegativeIntegerValue({ n: null }, 'n')).toBeNull();
    expect(nullableNonNegativeIntegerValue({ n: -1 }, 'n')).toBeUndefined();
    expect(nullableNonNegativeIntegerValue({ n: 0 }, 'n')).toBe(0);
    expect(nullableOneOf({ k: null }, 'k', ['a'])).toBeNull();
  });

  it('refuses what a column must not hold', () => {
    expect(dateValue({ d: at }, 'd')).toEqual(at);
    expect(stringValue({ s: '' }, 's')).toBeUndefined();
    expect(stringValue({ s: 'a' }, 's')).toBe('a');
    expect(integerValue({ n: 1.5 }, 'n')).toBeUndefined();
    expect(positiveIntegerValue({ n: 0 }, 'n')).toBeUndefined();
    expect(positiveIntegerValue({ n: 3 }, 'n')).toBe(3);
    expect(booleanValue({ b: 'true' }, 'b')).toBeUndefined();
    expect(stringArrayValue({ a: ['x', 1] }, 'a')).toBeUndefined();
    expect(stringArrayValue({ a: ['x'] }, 'a')).toEqual(['x']);
    expect(oneOf({ k: 'c' }, 'k', ['a', 'b'])).toBeUndefined();
    expect(oneOf({ k: 'b' }, 'k', ['a', 'b'])).toBe('b');
  });
});
