import { createIdempotencyFingerprint } from './idempotency-fingerprint';

describe('idempotency fingerprint', () => {
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

  // Stored idempotency records are keyed on this digest. If this literal has to
  // change, every record written before the change stops matching its replay.
  it('keeps producing the digest already stored for a known request', () => {
    expect(
      createIdempotencyFingerprint({
        organizationId: 'org_acme',
        operation: 'writing.task1.grade',
        actorId: 'user_123',
        requestBody: {
          answer: 'hello',
          metadata: { level: 2 },
          tags: ['b', 'a'],
        },
      }),
    ).toBe('524754b57971dc45076cb65af89574cb61410c4a327e67afef52d802ed75355e');
  });
});
