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

  // Shrunk counterexample from canonical-json.property.spec.ts (#329).
  it('keeps a __proto__ key, so it changes the bytes and the fingerprint', () => {
    expect(canonicalJson(JSON.parse('{"__proto__":{}}'))).toBe(
      '{"__proto__":{}}',
    );
    expect(
      canonicalJson(JSON.parse('{"a":1,"__proto__":{"role":"admin"}}')),
    ).toBe('{"__proto__":{"role":"admin"},"a":1}');
  });

  // RFC 8785 section 3.2.3: keys sort by UTF-16 code units, so a surrogate
  // pair (U+1F600) sorts before U+FB33 although its code point is larger.
  it('orders keys by UTF-16 code units, as RFC 8785 sets', () => {
    const entries: [string, string][] = [
      ['€', 'Euro Sign'],
      ['\r', 'Carriage Return'],
      ['דּ', 'Hebrew Letter Dalet With Dagesh'],
      ['1', 'One'],
      ['😀', 'Emoji: Grinning Face'],
      ['\u0080', 'Control'],
      ['ö', 'Latin Small Letter O With Diaeresis'],
    ];
    const sortedKeys = ['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ'];
    const values = new Map(entries);

    expect(canonicalJson(Object.fromEntries(entries))).toBe(
      `{${sortedKeys
        .map(
          (key) => `${JSON.stringify(key)}:${JSON.stringify(values.get(key))}`,
        )
        .join(',')}}`,
    );
  });

  // A JS object lists integer-like keys first, so a serializer that goes
  // through one cannot follow RFC 8785 order for these.
  it('orders integer-like keys as text, not as numbers', () => {
    expect(canonicalJson({ '2': 'b', '10': 'a', a: 'c' })).toBe(
      '{"10":"a","2":"b","a":"c"}',
    );
    expect(canonicalJson({ '1': 1, '!': 2 })).toBe('{"!":2,"1":1}');
  });

  // Stored idempotency fingerprints hang on this exact output (ADR-0164).
  it('keeps the bytes of an object with no integer-like key unchanged', () => {
    expect(
      canonicalJson({
        organization_id: 'org_acme',
        request: { tags: ['b', 'a'], answer: 'héllo', n: -0, big: 1e21 },
      }),
    ).toBe(
      '{"organization_id":"org_acme","request":{"answer":"héllo","big":1e+21,"n":0,"tags":["b","a"]}}',
    );
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
