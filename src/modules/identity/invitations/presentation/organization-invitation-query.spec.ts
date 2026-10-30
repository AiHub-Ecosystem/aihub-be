import { AppError } from '@/common/errors/app-error';
import { parseRequestQuery } from '@/common/http/parse-request-query';
import { ListOpenOrganizationInvitationsQuerySchema } from '@/contracts/organization/invitation';
import {
  DEFAULT_COLLECTION_PAGE_SIZE,
  MAX_COLLECTION_PAGE_SIZE,
} from '@/contracts/organization/pagination';
import { encodeCursor } from '@/modules/identity/shared/presentation/cursor-codec';
import {
  isInvitationCursorPosition,
  parseOrganizationInvitationQuery,
} from './organization-invitation-query';

const ORGANIZATION_ID = 'org_acme';
const OTHER_ORGANIZATION_ID = 'org_other';

describe('parseOrganizationInvitationQuery', () => {
  it('defaults limit when limit is omitted', () => {
    const result = parseOrganizationInvitationQuery({}, ORGANIZATION_ID);

    expect(result.limit).toBe(DEFAULT_COLLECTION_PAGE_SIZE);
    expect(result.after).toBeUndefined();
  });

  it('accepts an explicit integer limit within allowed bounds', () => {
    const result = parseOrganizationInvitationQuery(
      { limit: '25' },
      ORGANIZATION_ID,
    );

    expect(result.limit).toBe(25);
  });

  it('accepts maximum allowed limit', () => {
    const result = parseOrganizationInvitationQuery(
      { limit: String(MAX_COLLECTION_PAGE_SIZE) },
      ORGANIZATION_ID,
    );

    expect(result.limit).toBe(MAX_COLLECTION_PAGE_SIZE);
  });

  it('rejects a limit less than 1', () => {
    let thrown: unknown;
    try {
      parseOrganizationInvitationQuery({ limit: '0' }, ORGANIZATION_ID);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      httpStatus: 400,
      code: 'INVALID_REQUEST',
      details: {
        limit: `Limit must be between 1 and ${MAX_COLLECTION_PAGE_SIZE}`,
      },
    });
  });

  it('rejects a limit exceeding maximum page size', () => {
    let thrown: unknown;
    try {
      parseOrganizationInvitationQuery(
        { limit: String(MAX_COLLECTION_PAGE_SIZE + 1) },
        ORGANIZATION_ID,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      httpStatus: 400,
      code: 'INVALID_REQUEST',
      details: {
        limit: `Limit must be between 1 and ${MAX_COLLECTION_PAGE_SIZE}`,
      },
    });
  });

  it('rejects a non-integer limit format', () => {
    let thrown: unknown;
    try {
      parseOrganizationInvitationQuery({ limit: 'abc' }, ORGANIZATION_ID);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      httpStatus: 400,
      code: 'INVALID_REQUEST',
      details: {
        limit: 'Limit must be an integer string',
      },
    });
  });

  it('decodes a valid cursor bound to the organization', () => {
    const cursor = encodeCursor(
      {
        createdAt: '2026-09-24T12:00:00.000Z',
        id: 'oiv_01J00000000000000000000001',
      },
      { organizationId: ORGANIZATION_ID },
    );

    const result = parseOrganizationInvitationQuery(
      { cursor },
      ORGANIZATION_ID,
    );

    expect(result.after).toEqual({
      createdAt: new Date('2026-09-24T12:00:00.000Z'),
      id: 'oiv_01J00000000000000000000001',
    });
  });

  it('rejects an empty cursor', () => {
    let thrown: unknown;
    try {
      parseOrganizationInvitationQuery({ cursor: '   ' }, ORGANIZATION_ID);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      httpStatus: 400,
      code: 'INVALID_REQUEST',
      details: {
        cursor: 'Cursor must be a non-empty string',
      },
    });
  });

  it('rejects a cursor issued for another organization', () => {
    const cursor = encodeCursor(
      {
        createdAt: '2026-09-24T12:00:00.000Z',
        id: 'oiv_01J00000000000000000000001',
      },
      { organizationId: OTHER_ORGANIZATION_ID },
    );

    let thrown: unknown;
    try {
      parseOrganizationInvitationQuery({ cursor }, ORGANIZATION_ID);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      httpStatus: 400,
      code: 'INVALID_REQUEST',
      details: {
        cursor: 'Cursor does not match the requested scope',
      },
    });
  });

  it.each(['2020', '2026-09-24', '2026-09-24T12:00:00Z', 'not-a-date'])(
    'rejects a signed cursor whose createdAt "%s" is not a minted timestamp',
    (createdAt) => {
      const cursor = encodeCursor(
        { createdAt, id: 'oiv_01J00000000000000000000001' },
        { organizationId: ORGANIZATION_ID },
      );

      let thrown: unknown;
      try {
        parseOrganizationInvitationQuery({ cursor }, ORGANIZATION_ID);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        httpStatus: 400,
        code: 'INVALID_REQUEST',
        details: { cursor: 'Cursor position is invalid' },
      });
    },
  );

  it.each([{ limit: ['1', '2'] }, { cursor: ['a', 'b'] }])(
    'rejects a repeated query key %j',
    (query) => {
      let thrown: unknown;
      try {
        parseRequestQuery(ListOpenOrganizationInvitationsQuerySchema, query);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        httpStatus: 400,
        code: 'INVALID_REQUEST',
      });
    },
  );

  it('validates cursor position shape correctly', () => {
    expect(isInvitationCursorPosition(null)).toBe(false);
    expect(isInvitationCursorPosition({})).toBe(false);
    expect(
      isInvitationCursorPosition({
        createdAt: 'not-a-date',
        id: 'oiv_01',
      }),
    ).toBe(false);
    expect(
      isInvitationCursorPosition({
        createdAt: '2026-09-24T12:00:00.000Z',
        id: '',
      }),
    ).toBe(false);
    expect(
      isInvitationCursorPosition({
        createdAt: '2026-09-24T12:00:00.000Z',
        id: 'oiv_01',
      }),
    ).toBe(true);
  });
});
