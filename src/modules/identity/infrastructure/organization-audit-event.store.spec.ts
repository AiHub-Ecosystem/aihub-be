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

  /**
   * The read path orders by `occurred_at` and tie-breaks on `id` alone, so two
   * events stamped with one instant — a denial recorded beside the mutation it
   * refused, two events written inside one request — have to keep the order
   * they were written in. A plain ULID does not: it randomises everything after
   * the millisecond prefix.
   */
  it('keeps write order for events that share an instant', () => {
    const occurredAt = new Date('2026-09-21T12:00:00.000Z');

    const ids = Array.from({ length: 20 }, () =>
      organizationAuditEventId(occurredAt),
    );

    expect([...ids].sort()).toEqual(ids);
  });
});
