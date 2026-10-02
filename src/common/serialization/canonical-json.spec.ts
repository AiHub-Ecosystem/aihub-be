import { canonicalJson } from './canonical-json';

describe('canonicalJson', () => {
  it('sorts object keys recursively but preserves array order', () => {
    expect(
      canonicalJson({
        z: 1,
        nested: { b: 2, a: 1 },
        values: [{ y: true, x: false }, 'last'],
        a: 'first',
      }),
    ).toBe(
      '{"a":"first","nested":{"a":1,"b":2},"values":[{"x":false,"y":true},"last"],"z":1}',
    );
  });

  it('gives the same bytes for the same logical value regardless of key order', () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe(
      canonicalJson({ a: null, b: [{ c: 2, d: 1 }] }),
    );
  });

  it('serializes scalars exactly as JSON does', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
  });

  it('rejects undefined, in a property and at the root', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson(undefined)).toThrow(/unsupported/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects the non-finite number %s',
    (value) => {
      expect(() => canonicalJson({ n: value })).toThrow(/non-finite/);
    },
  );

  it.each([
    ['bigint', 1n],
    ['function', () => 1],
    ['symbol', Symbol('s')],
  ])('rejects a %s', (_name, value) => {
    expect(() => canonicalJson({ v: value })).toThrow(/unsupported/);
  });
});
