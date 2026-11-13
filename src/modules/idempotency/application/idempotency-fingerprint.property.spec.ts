import { isDeepStrictEqual } from 'node:util';

import * as fc from 'fast-check';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { isOperationId } from '@/catalog/operation-id';

import { PROPERTY_OPTIONS } from '../../../../test/support/property-options';
import {
  type IdempotencyFingerprintInput,
  createIdempotencyFingerprint,
} from './idempotency-fingerprint';

const operationArbitrary = fc.constantFrom(
  ...Object.keys(OPERATION_CATALOG).filter(isOperationId),
);
const organizationArbitrary = fc.option(fc.string({ maxLength: 12 }), {
  nil: null,
});
const keyArbitrary = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.constantFrom('__proto__', 'constructor', 'prototype'),
);
const bodyArbitrary = fc.object({
  key: keyArbitrary,
  values: [fc.string({ maxLength: 6 }), fc.integer(), fc.boolean()],
  maxDepth: 3,
  maxKeys: 4,
});
const inputArbitrary = fc.record({
  organizationId: organizationArbitrary,
  operation: operationArbitrary,
  actorId: fc.string({ maxLength: 12 }),
  requestBody: bodyArbitrary,
});

/** The same object with its own keys inserted in reverse order, recursively. */
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeyOrder(item)]),
    );
  }
  return value;
}

describe('idempotency fingerprint properties', () => {
  it('gives semantically equal requests the same fingerprint', () => {
    fc.assert(
      fc.property(inputArbitrary, (input) => {
        expect(
          createIdempotencyFingerprint({
            ...input,
            requestBody: reverseKeyOrder(input.requestBody),
          }),
        ).toBe(createIdempotencyFingerprint(input));
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('changes the fingerprint when the organization differs', () => {
    fc.assert(
      fc.property(inputArbitrary, organizationArbitrary, (input, other) => {
        fc.pre(other !== input.organizationId);
        expect(
          createIdempotencyFingerprint({ ...input, organizationId: other }),
        ).not.toBe(createIdempotencyFingerprint(input));
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('changes the fingerprint when the operation differs', () => {
    fc.assert(
      fc.property(inputArbitrary, operationArbitrary, (input, other) => {
        fc.pre(other !== input.operation);
        expect(
          createIdempotencyFingerprint({ ...input, operation: other }),
        ).not.toBe(createIdempotencyFingerprint(input));
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('changes the fingerprint when the actor differs', () => {
    fc.assert(
      fc.property(
        inputArbitrary,
        fc.string({ maxLength: 12 }),
        (input, other) => {
          fc.pre(other !== input.actorId);
          expect(
            createIdempotencyFingerprint({ ...input, actorId: other }),
          ).not.toBe(createIdempotencyFingerprint(input));
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  it('changes the fingerprint when the request body differs', () => {
    fc.assert(
      fc.property(inputArbitrary, bodyArbitrary, (input, other) => {
        // An oracle independent of canonicalJson: Node's own deep equality.
        fc.pre(!isDeepStrictEqual(other, input.requestBody));
        const changed: IdempotencyFingerprintInput = {
          ...input,
          requestBody: other,
        };
        expect(createIdempotencyFingerprint(changed)).not.toBe(
          createIdempotencyFingerprint(input),
        );
      }),
      PROPERTY_OPTIONS,
    );
  });
});
