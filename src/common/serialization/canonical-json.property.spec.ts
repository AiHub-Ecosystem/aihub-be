import * as fc from 'fast-check';

import { isRecord } from '@/common/is-record';

import { PROPERTY_OPTIONS } from '../../../test/support/property-options';
import { canonicalJson } from './canonical-json';

const POLLUTING_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

// `binary` units reach non-ASCII and lone surrogates, where UTF-16 code-unit
// order (RFC 8785) and code-point order disagree.
const keyArbitrary = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.string({ unit: 'binary', maxLength: 4 }),
  fc.constantFrom(...POLLUTING_KEYS),
);

const jsonValueArbitrary = fc.object({
  key: keyArbitrary,
  values: [
    fc.string({ maxLength: 8 }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
  ],
  maxDepth: 3,
  maxKeys: 5,
});

/**
 * The same value with every object's own keys reversed, then rotated by
 * `shift`, at every depth. `Object.fromEntries` keeps `__proto__` a plain key.
 */
function withKeysReordered(value: unknown, shift: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => withKeysReordered(item, shift));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).reverse();
    const pivot = entries.length === 0 ? 0 : shift % entries.length;
    return Object.fromEntries(
      [...entries.slice(pivot), ...entries.slice(0, pivot)].map(
        ([key, item]) => [key, withKeysReordered(item, shift)],
      ),
    );
  }
  return value;
}

describe('canonicalJson properties', () => {
  it('serializes objects equal up to key order, at any depth, to identical bytes', () => {
    fc.assert(
      fc.property(jsonValueArbitrary, fc.nat(8), (value, shift) => {
        expect(canonicalJson(withKeysReordered(value, shift))).toBe(
          canonicalJson(value),
        );
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('is idempotent: serializing the parsed output gives the same bytes', () => {
    fc.assert(
      fc.property(jsonValueArbitrary, (value) => {
        const once = canonicalJson(value);
        expect(canonicalJson(JSON.parse(once))).toBe(once);
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('keeps every generated key, including __proto__, constructor and prototype', () => {
    fc.assert(
      fc.property(jsonValueArbitrary, (value) => {
        const parsed: unknown = JSON.parse(canonicalJson(value));
        expect(isRecord(parsed) ? Object.keys(parsed).sort() : parsed).toEqual(
          Object.keys(value).sort(),
        );
      }),
      PROPERTY_OPTIONS,
    );
  });
});
