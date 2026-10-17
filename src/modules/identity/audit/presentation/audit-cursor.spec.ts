import {
  auditFilterHash,
  decodeAuditCursor,
  encodeAuditCursor,
} from './audit-cursor';

describe('decodeAuditCursor', () => {
  const position = {
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    id: 'oae_01J00000000000000000000000',
  };

  function forged(id: string): string {
    return Buffer.from(
      JSON.stringify({
        v: 1,
        occurredAt: position.occurredAt.toISOString(),
        id,
        f: auditFilterHash({}),
      }),
      'utf8',
    ).toString('base64url');
  }

  it('reads back the position it encoded', () => {
    expect(decodeAuditCursor(encodeAuditCursor(position, {}), {})).toEqual(
      position,
    );
  });

  it.each(['', 'oae_01J0000000000000000000000\u0000', "x' OR 1=1", 'oae_'])(
    'refuses a cursor whose id %j is not an event id',
    (id) => {
      expect(decodeAuditCursor(forged(id), {})).toBeUndefined();
    },
  );
});

describe('audit cursor filter hash', () => {
  // A cursor already in a client's hands carries this hash. If a literal here
  // has to change, every outstanding cursor stops matching its filter.
  it('keeps producing the hash already embedded in issued cursors', () => {
    expect(
      auditFilterHash({
        actions: ['organization.renamed', 'organization.created'],
        outcome: 'applied',
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2026-02-01T00:00:00.000Z'),
      }),
    ).toBe('5c4b01d63a779077');
    expect(auditFilterHash({})).toBe('caf253d93bc3ac1a');
  });

  it('treats the same actions in another order as the same filter', () => {
    expect(
      auditFilterHash({
        actions: ['organization.created', 'organization.renamed'],
      }),
    ).toBe(
      auditFilterHash({
        actions: ['organization.renamed', 'organization.created'],
      }),
    );
  });
});
