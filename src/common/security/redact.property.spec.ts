import * as fc from 'fast-check';

import { PROPERTY_OPTIONS } from '../../../test/support/property-options';
import { redactRecord } from './redact';

const SENSITIVE_KEYS = [
  'api_key',
  'api-key',
  'x-api-key',
  'authorization',
  'user_assertion',
  'x-user-identity',
  'x-user-assertion',
  'internal_token',
  'essay',
  'body',
] as const;

const POLLUTING_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

const isSensitive = (key: string): boolean =>
  (SENSITIVE_KEYS as readonly string[]).includes(key.toLowerCase());

const safeKeyArbitrary = fc.oneof(
  fc.string({ maxLength: 8 }).filter((key) => !isSensitive(key)),
  fc.constantFrom(...POLLUTING_KEYS),
);

const safeTreeArbitrary = fc.object({
  key: safeKeyArbitrary,
  values: [fc.string({ maxLength: 8 }), fc.integer(), fc.boolean()],
  maxDepth: 3,
  maxKeys: 4,
});

/** A key that redaction must treat as sensitive, in a random letter case. */
const sensitiveKeyArbitrary = fc
  .tuple(fc.constantFrom(...SENSITIVE_KEYS), fc.boolean())
  .map(([key, upper]) => (upper ? key.toUpperCase() : key));

const secretArbitrary = fc.stringMatching(/^aihub_sk_[0-9a-f]{24,40}$/);

/** Wraps `leaf` in `steps` levels of object or array nesting. */
function nest(
  leaf: unknown,
  steps: readonly { readonly array: boolean; readonly key: string }[],
): unknown {
  return steps.reduceRight<unknown>(
    (inner, step) =>
      step.array ? [inner] : Object.fromEntries([[step.key, inner]]),
    leaf,
  );
}

describe('redactRecord properties', () => {
  it('leaves no generated secret in the output, wherever it is nested', () => {
    fc.assert(
      fc.property(
        safeTreeArbitrary,
        sensitiveKeyArbitrary,
        secretArbitrary,
        fc.array(fc.record({ array: fc.boolean(), key: safeKeyArbitrary }), {
          maxLength: 5,
        }),
        (tree, sensitiveKey, secret, steps) => {
          const input = {
            ...tree,
            wrapper: nest(Object.fromEntries([[sensitiveKey, secret]]), steps),
          };

          expect(JSON.stringify(redactRecord(input))).not.toContain(secret);
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  it('keeps every non-sensitive key, including __proto__, constructor and prototype', () => {
    fc.assert(
      fc.property(safeTreeArbitrary, (tree) => {
        expect(Object.keys(redactRecord(tree))).toEqual(Object.keys(tree));
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('does not change a structure with nothing sensitive in it', () => {
    fc.assert(
      fc.property(safeTreeArbitrary, (tree) => {
        expect(JSON.stringify(redactRecord(tree))).toBe(JSON.stringify(tree));
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(safeTreeArbitrary, sensitiveKeyArbitrary, (tree, key) => {
        const once = redactRecord({ ...tree, [key]: 'secret' });
        expect(JSON.stringify(redactRecord(once))).toBe(JSON.stringify(once));
      }),
      PROPERTY_OPTIONS,
    );
  });
});
