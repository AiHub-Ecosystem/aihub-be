import { organizationAuditEventId } from './organization-audit-event.store';

describe('organizationAuditEventId', () => {
  it('prefixes a ULID', () => {
    const id = organizationAuditEventId(new Date('2026-09-21T12:00:00.000Z'));

    expect(id).toMatch(/^oae_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts by the instant it was stamped with', () => {
    const earlier = organizationAuditEventId(
      new Date('2026-09-21T12:00:00.000Z'),
    );
    const later = organizationAuditEventId(
      new Date('2026-09-21T12:00:01.000Z'),
    );

    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it('keeps mint order within this process for events that share an instant', () => {
    const occurredAt = new Date('2026-09-21T12:00:00.000Z');

    const ids = Array.from({ length: 20 }, () =>
      organizationAuditEventId(occurredAt),
    );

    expect([...ids].sort()).toEqual(ids);
  });
});
