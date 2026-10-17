import { invalidRequest } from '@/common/errors/invalid-request';
import { encodeAuditCursor } from './audit-cursor';
import { parseOrganizationAuditQuery } from './audit-event-query';

const VALID_ACTIONS = ['organization.created', 'organization.renamed'];

describe('parseOrganizationAuditQuery', () => {
  it('accepts an empty query with the default page size', () => {
    expect(parseOrganizationAuditQuery(undefined)).toEqual({
      filter: {},
      limit: 50,
    });
    expect(parseOrganizationAuditQuery(null)).toEqual({
      filter: {},
      limit: 50,
    });
    expect(parseOrganizationAuditQuery({})).toEqual({
      filter: {},
      limit: 50,
    });
  });

  it('accepts a fully populated query', () => {
    const result = parseOrganizationAuditQuery({
      action: VALID_ACTIONS[0],
      outcome: 'applied',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      limit: '50',
    });

    expect(result.filter).toEqual({
      actions: [VALID_ACTIONS[0]],
      outcome: 'applied',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(result.limit).toBe(50);
    expect(result.after).toBeUndefined();
  });

  it('accepts an action given as an array', () => {
    const result = parseOrganizationAuditQuery({
      action: VALID_ACTIONS,
    });

    expect(result.filter).toEqual({ actions: VALID_ACTIONS });
  });

  it('accepts a cursor that matches the filter', () => {
    const filter = { outcome: 'applied' as const };
    const cursor = encodeAuditCursor(
      { occurredAt: new Date('2026-01-15T00:00:00.000Z'), id: 'evt_1' },
      filter,
    );

    const result = parseOrganizationAuditQuery({ outcome: 'applied', cursor });

    expect(result.after).toEqual({
      occurredAt: new Date('2026-01-15T00:00:00.000Z'),
      id: 'evt_1',
    });
  });

  describe('refusals', () => {
    function expectRefused(raw: unknown): void {
      expect(() => parseOrganizationAuditQuery(raw)).toThrow(invalidRequest());
    }

    // eslint-disable-next-line jest/expect-expect
    it('refuses an action that is not a string', () => {
      expectRefused({ action: 5 });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses an action that is not a known action', () => {
      expectRefused({ action: 'not.an.action' });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses an action array containing a non-string', () => {
      expectRefused({ action: ['organization.created', 5] });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses an action array containing an unknown action', () => {
      expectRefused({ action: ['organization.created', 'nope'] });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses an outcome that is not a string', () => {
      expectRefused({ outcome: 5 });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses an unknown outcome', () => {
      expectRefused({ outcome: 'nope' });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a from bound that is not a string', () => {
      expectRefused({ from: 5 });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a from bound that does not parse', () => {
      expectRefused({ from: 'not-a-date' });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a to bound that is not a string', () => {
      expectRefused({ to: 5 });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a to bound that does not parse', () => {
      expectRefused({ to: 'not-a-date' });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a range whose from is not before to', () => {
      expectRefused({
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      });
      expectRefused({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a limit that is not a string', () => {
      expectRefused({ limit: 5 });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a limit that is not an integer string', () => {
      expectRefused({ limit: '5.5' });
      expectRefused({ limit: 'abc' });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a limit below one', () => {
      expectRefused({ limit: '0' });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a limit above the maximum', () => {
      expectRefused({ limit: '999' });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a cursor that is not a string', () => {
      expectRefused({ cursor: 5 });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a cursor that does not decode', () => {
      expectRefused({ cursor: 'not-a-cursor' });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses a cursor minted against a different filter', () => {
      const cursor = encodeAuditCursor(
        { occurredAt: new Date('2026-01-15T00:00:00.000Z'), id: 'evt_1' },
        {},
      );
      expectRefused({ outcome: 'success', cursor });
    });

    // eslint-disable-next-line jest/expect-expect
    it('refuses an undeclared parameter', () => {
      expectRefused({ foo: 'bar' });
      expectRefused({ action: VALID_ACTIONS[0], bar: 1 });
    });
  });
});
