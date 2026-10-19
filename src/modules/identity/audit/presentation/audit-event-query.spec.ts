import { invalidRequest } from '@/common/errors/invalid-request';
import { parseRequestQuery } from '@/common/http/parse-request-query';
import { OrganizationAuditEventQuerySchema } from '@/contracts/organization/audit-event';
import { encodeAuditCursor } from './audit-cursor';
import { parseOrganizationAuditQuery as parseValidatedOrganizationAuditQuery } from './audit-event-query';

const VALID_ACTIONS = ['organization.created', 'organization.renamed'];

function parseOrganizationAuditQuery(raw: unknown) {
  return parseValidatedOrganizationAuditQuery(
    parseRequestQuery(OrganizationAuditEventQuerySchema, raw),
  );
}

describe('parseOrganizationAuditQuery', () => {
  it('accepts an empty query with the default page size', () => {
    expect(parseOrganizationAuditQuery(undefined)).toEqual({
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
      {
        occurredAt: new Date('2026-01-15T00:00:00.000Z'),
        id: 'oae_01J00000000000000000000001',
      },
      filter,
    );

    const result = parseOrganizationAuditQuery({ outcome: 'applied', cursor });

    expect(result.after).toEqual({
      occurredAt: new Date('2026-01-15T00:00:00.000Z'),
      id: 'oae_01J00000000000000000000001',
    });
  });

  describe('refusals', () => {
    function expectRefused(raw: unknown): void {
      expect(() => parseOrganizationAuditQuery(raw)).toThrow(invalidRequest());
    }

    it('refuses an action that is not a string', () => {
      expectRefused({ action: 5 });
    });

    it('refuses an action that is not a known action', () => {
      expectRefused({ action: 'not.an.action' });
    });

    it('refuses an action array containing a non-string', () => {
      expectRefused({ action: ['organization.created', 5] });
    });

    it('refuses an action array containing an unknown action', () => {
      expectRefused({ action: ['organization.created', 'nope'] });
    });

    it('refuses an outcome that is not a string', () => {
      expectRefused({ outcome: 5 });
    });

    it('refuses an unknown outcome', () => {
      expectRefused({ outcome: 'nope' });
    });

    it('refuses a from bound that is not a string', () => {
      expectRefused({ from: 5 });
    });

    it('refuses a from bound that does not parse', () => {
      expectRefused({ from: 'not-a-date' });
    });

    it('refuses a to bound that is not a string', () => {
      expectRefused({ to: 5 });
    });

    it('refuses a to bound that does not parse', () => {
      expectRefused({ to: 'not-a-date' });
    });

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

    it('refuses a limit that is not a string', () => {
      expectRefused({ limit: 5 });
    });

    it('refuses a limit that is not an integer string', () => {
      expectRefused({ limit: '5.5' });
      expectRefused({ limit: 'abc' });
    });

    it('refuses a limit below one', () => {
      expectRefused({ limit: '0' });
    });

    it('refuses a limit above the maximum', () => {
      expectRefused({ limit: '999' });
    });

    it('refuses a cursor that is not a string', () => {
      expectRefused({ cursor: 5 });
    });

    it('refuses a cursor that does not decode', () => {
      expectRefused({ cursor: 'not-a-cursor' });
    });

    it('refuses a cursor minted against a different filter', () => {
      const cursor = encodeAuditCursor(
        {
          occurredAt: new Date('2026-01-15T00:00:00.000Z'),
          id: 'oae_01J00000000000000000000001',
        },
        {},
      );
      expectRefused({ outcome: 'success', cursor });
    });

    it('refuses an undeclared parameter', () => {
      expectRefused({ foo: 'bar' });
      expectRefused({ action: VALID_ACTIONS[0], bar: 1 });
    });
  });
});
