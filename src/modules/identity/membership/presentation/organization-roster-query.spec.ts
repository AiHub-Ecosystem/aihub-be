import { AppError } from '@/common/errors/app-error';
import {
  DEFAULT_ROSTER_PAGE_SIZE,
  MAX_ROSTER_PAGE_SIZE,
} from '@/contracts/organization/pagination';
import { encodeCursor } from '@/modules/identity/shared/presentation/cursor-codec';

import {
  parseOrganizationRosterQuery,
  rosterCursorScope,
} from './organization-roster-query';

const USER_ID = 'usr_01J00000000000000000000000';

function refusal(query: { limit?: string; cursor?: string }): AppError {
  try {
    parseOrganizationRosterQuery(query, USER_ID);
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('query was accepted');
}

describe('parseOrganizationRosterQuery', () => {
  it('takes the default page size and no position without parameters', () => {
    expect(parseOrganizationRosterQuery({}, USER_ID)).toEqual({
      limit: DEFAULT_ROSTER_PAGE_SIZE,
    });
  });

  it('accepts the bounds of the roster range', () => {
    expect(parseOrganizationRosterQuery({ limit: '1' }, USER_ID).limit).toBe(1);
    expect(
      parseOrganizationRosterQuery(
        { limit: String(MAX_ROSTER_PAGE_SIZE) },
        USER_ID,
      ).limit,
    ).toBe(MAX_ROSTER_PAGE_SIZE);
  });

  it('refuses a limit past the roster maximum, which is below the shared one', () => {
    const error = refusal({ limit: String(MAX_ROSTER_PAGE_SIZE + 1) });

    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.details).toEqual({
      limit: `Limit must be between 1 and ${MAX_ROSTER_PAGE_SIZE}`,
    });
  });

  it('resumes after the Organization named in the caller’s own cursor', () => {
    const cursor = encodeCursor(
      { organizationId: 'org_acme' },
      rosterCursorScope(USER_ID),
    );

    expect(parseOrganizationRosterQuery({ cursor }, USER_ID)).toEqual({
      limit: DEFAULT_ROSTER_PAGE_SIZE,
      after: 'org_acme',
    });
  });

  it('refuses a cursor minted for another caller', () => {
    const cursor = encodeCursor(
      { organizationId: 'org_acme' },
      rosterCursorScope('usr_someone_else'),
    );

    expect(refusal({ cursor }).code).toBe('INVALID_REQUEST');
  });

  it('refuses a cursor whose position is not an Organization', () => {
    const cursor = encodeCursor(
      { username: 'alice' },
      rosterCursorScope(USER_ID),
    );

    expect(refusal({ cursor }).code).toBe('INVALID_REQUEST');
  });

  it('refuses a cursor from an unsupported version', () => {
    const cursor = Buffer.from(
      JSON.stringify({ v: 2, pos: { organizationId: 'org_acme' }, s: 'x' }),
    ).toString('base64url');

    expect(refusal({ cursor }).code).toBe('INVALID_REQUEST');
  });
});
