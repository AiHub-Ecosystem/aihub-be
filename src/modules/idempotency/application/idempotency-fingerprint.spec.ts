import {
  canonicalJson,
  createIdempotencyFingerprint,
} from './idempotency-fingerprint';

describe('idempotency fingerprint', () => {
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

  it('includes organization, operation, actor, and request body in the hash', () => {
    const base = {
      organizationId: 'org_acme',
      operation: 'writing.task1.grade' as const,
      actorId: 'user_123',
      requestBody: { answer: 'hello', metadata: { level: 2 } },
    };

    expect(createIdempotencyFingerprint(base)).toBe(
      createIdempotencyFingerprint({
        ...base,
        requestBody: { metadata: { level: 2 }, answer: 'hello' },
      }),
    );
    expect(
      createIdempotencyFingerprint({ ...base, actorId: 'user_456' }),
    ).not.toBe(createIdempotencyFingerprint(base));
    expect(
      createIdempotencyFingerprint({
        ...base,
        requestBody: { answer: 'hello', metadata: { level: 3 } },
      }),
    ).not.toBe(createIdempotencyFingerprint(base));
  });
});
