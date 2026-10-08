import { auditFilterHash } from './audit-cursor';

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
