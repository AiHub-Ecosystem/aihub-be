import { AppError } from '@/common/errors/app-error';
import { parseRequestQuery } from '@/common/http/parse-request-query';
import { OrganizationMembershipListQuerySchema } from '@/contracts/organization/membership';
import {
  DEFAULT_COLLECTION_PAGE_SIZE,
  MAX_COLLECTION_PAGE_SIZE,
} from '@/contracts/organization/pagination';
import { encodeCursor } from '@/modules/identity/shared/presentation/cursor-codec';
import {
  isMemberCursorPosition,
  parseOrganizationMembershipQuery as parseValidatedQuery,
} from './organization-membership-query';

const ORGANIZATION_ID = 'org_acme';

function parseOrganizationMembershipQuery(
  raw: unknown,
  organizationId = ORGANIZATION_ID,
) {
  const validated = parseRequestQuery(
    OrganizationMembershipListQuerySchema,
    raw,
  );
  return parseValidatedQuery(validated, organizationId);
}

describe('parseOrganizationMembershipQuery', () => {
  it('accepts an empty query with defaults', () => {
    expect(parseOrganizationMembershipQuery(undefined)).toEqual({
      status: 'active',
      limit: DEFAULT_COLLECTION_PAGE_SIZE,
      after: undefined,
    });
    expect(parseOrganizationMembershipQuery({})).toEqual({
      status: 'active',
      limit: 100,
      after: undefined,
    });
  });

  it('accepts an explicit status filter', () => {
    const result = parseOrganizationMembershipQuery({ status: 'disabled' });
    expect(result).toEqual({
      status: 'disabled',
      limit: 100,
      after: undefined,
    });
  });

  it('accepts an explicit valid limit', () => {
    const result = parseOrganizationMembershipQuery({ limit: '50' });
    expect(result).toEqual({
      status: 'active',
      limit: 50,
      after: undefined,
    });
  });

  it('accepts maximum allowed limit', () => {
    const result = parseOrganizationMembershipQuery({
      limit: String(MAX_COLLECTION_PAGE_SIZE),
    });
    expect(result.limit).toBe(500);
  });

  it('accepts minimum allowed limit', () => {
    const result = parseOrganizationMembershipQuery({ limit: '1' });
    expect(result.limit).toBe(1);
  });

  it('accepts a valid cursor matching the organization and default status', () => {
    const cursor = encodeCursor(
      { username: 'bob' },
      { organizationId: ORGANIZATION_ID, status: 'active' },
    );
    const result = parseOrganizationMembershipQuery({ cursor });
    expect(result.after).toBe('bob');
    expect(result.status).toBe('active');
  });

  it('accepts a valid cursor matching the organization and explicit status', () => {
    const cursor = encodeCursor(
      { username: 'carol' },
      { organizationId: ORGANIZATION_ID, status: 'disabled' },
    );
    const result = parseOrganizationMembershipQuery({
      status: 'disabled',
      cursor,
    });
    expect(result.after).toBe('carol');
    expect(result.status).toBe('disabled');
  });

  describe('refusals', () => {
    function expectRefused(
      raw: unknown,
      organizationId = ORGANIZATION_ID,
    ): void {
      let thrown: unknown;
      try {
        parseOrganizationMembershipQuery(raw, organizationId);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect(thrown).toMatchObject({
        code: 'INVALID_REQUEST',
        httpStatus: 400,
      });
    }

    it('refuses an undeclared query parameter', () => {
      expectRefused({ unexpected: 'value' });
    });

    it('refuses a repeated limit, cursor, or status key', () => {
      expectRefused({ limit: ['1', '2'] });
      expectRefused({ cursor: ['a', 'b'] });
      expectRefused({ status: ['active', 'disabled'] });
    });

    it('refuses an unknown status', () => {
      expectRefused({ status: 'unknown' });
    });

    it('refuses a limit that is not an integer string', () => {
      expectRefused({ limit: '10.5' });
      expectRefused({ limit: 'abc' });
      expectRefused({ limit: '' });
    });

    it('refuses a limit below one', () => {
      expectRefused({ limit: '0' });
      expectRefused({ limit: '-1' });
    });

    it('refuses a limit above maximum 500', () => {
      expectRefused({ limit: '501' });
    });

    it('refuses a malformed cursor', () => {
      expectRefused({ cursor: 'not!a!valid!cursor' });
    });

    it('refuses a cursor minted for another organization', () => {
      const cursor = encodeCursor(
        { username: 'bob' },
        { organizationId: 'org_other', status: 'active' },
      );
      expectRefused({ cursor }, ORGANIZATION_ID);
    });

    it('refuses a cursor minted for another status', () => {
      const cursor = encodeCursor(
        { username: 'bob' },
        { organizationId: ORGANIZATION_ID, status: 'disabled' },
      );
      expectRefused({ status: 'active', cursor });
    });

    it('refuses a stale cursor version', () => {
      const stale = Buffer.from(
        JSON.stringify({
          v: 99,
          pos: { username: 'bob' },
          s: '1234567890abcdef',
        }),
        'utf8',
      ).toString('base64url');
      expectRefused({ cursor: stale });
    });
  });

  describe('isMemberCursorPosition', () => {
    it('validates member cursor position object', () => {
      expect(isMemberCursorPosition({ username: 'alice' })).toBe(true);
      expect(isMemberCursorPosition(null)).toBe(false);
      expect(isMemberCursorPosition({})).toBe(false);
      expect(isMemberCursorPosition({ username: '' })).toBe(false);
      expect(isMemberCursorPosition({ username: 123 })).toBe(false);
    });
  });
});
