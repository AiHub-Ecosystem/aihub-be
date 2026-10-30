import { AppError } from '@/common/errors/app-error';
import {
  CURSOR_VERSION,
  computeScopeHash,
  decodeCursor,
  encodeCursor,
  tryDecodeCursor,
} from './cursor-codec';

interface TestPosition {
  readonly username: string;
}

function isTestPosition(value: unknown): value is TestPosition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.username === 'string' && candidate.username.length > 0
  );
}

describe('cursor-codec', () => {
  const scope = {
    organizationId: 'org_acme',
    status: 'active',
  };

  it('encodes and decodes a position matching the scope', () => {
    const position: TestPosition = { username: 'alice' };
    const cursor = encodeCursor(position, scope);

    expect(typeof cursor).toBe('string');
    expect(cursor.length).toBeGreaterThan(0);

    const decoded = decodeCursor(cursor, scope, isTestPosition);
    expect(decoded).toEqual(position);
  });

  it('accepts cursor when scope keys arrive in a different order', () => {
    const position: TestPosition = { username: 'bob' };
    const cursor = encodeCursor(position, {
      organizationId: 'org_acme',
      status: 'active',
    });

    const reorderedScope = {
      status: 'active',
      organizationId: 'org_acme',
    };

    const decoded = decodeCursor(cursor, reorderedScope, isTestPosition);
    expect(decoded).toEqual(position);
  });

  it('produces a deterministic scope hash for identical scopes', () => {
    const hash1 = computeScopeHash({
      organizationId: 'org_1',
      status: 'active',
    });
    const hash2 = computeScopeHash({
      status: 'active',
      organizationId: 'org_1',
    });
    expect(hash1).toBe(hash2);
  });

  describe('tryDecodeCursor', () => {
    it('refuses an empty or non-string input as malformed', () => {
      const result = tryDecodeCursor('', scope, isTestPosition);
      expect(result).toEqual({
        kind: 'malformed',
        reason: 'Cursor must be a non-empty string',
      });
    });

    it('refuses invalid base64url characters as malformed', () => {
      const result = tryDecodeCursor('not!valid@base64', scope, isTestPosition);
      expect(result).toEqual({
        kind: 'malformed',
        reason: 'Cursor contains invalid characters',
      });
    });

    it('refuses non-JSON content as malformed', () => {
      const invalidJson = Buffer.from('this is not json', 'utf8').toString(
        'base64url',
      );
      const result = tryDecodeCursor(invalidJson, scope, isTestPosition);
      expect(result).toEqual({
        kind: 'malformed',
        reason: 'Cursor is not valid JSON',
      });
    });

    it('refuses non-object JSON payload as malformed', () => {
      const arrayJson = Buffer.from('[1, 2, 3]', 'utf8').toString('base64url');
      const result = tryDecodeCursor(arrayJson, scope, isTestPosition);
      expect(result).toEqual({
        kind: 'malformed',
        reason: 'Cursor payload is not an object',
      });
    });

    it('refuses missing or invalid version as malformed', () => {
      const badVersion = Buffer.from(
        JSON.stringify({
          v: '1',
          pos: { username: 'alice' },
          s: '1234567890abcdef',
        }),
        'utf8',
      ).toString('base64url');
      const result = tryDecodeCursor(badVersion, scope, isTestPosition);
      expect(result).toEqual({
        kind: 'malformed',
        reason: 'Cursor version is missing or invalid',
      });
    });

    it('refuses unsupported version as stale', () => {
      const stale = Buffer.from(
        JSON.stringify({
          v: CURSOR_VERSION + 1,
          pos: { username: 'alice' },
          s: computeScopeHash(scope),
        }),
        'utf8',
      ).toString('base64url');
      const result = tryDecodeCursor(stale, scope, isTestPosition);
      expect(result).toEqual({
        kind: 'stale',
        reason: `Cursor version ${CURSOR_VERSION + 1} is not supported`,
      });
    });

    it('refuses a cursor minted against a different organization as mismatched', () => {
      const position: TestPosition = { username: 'alice' };
      const otherOrgScope = {
        organizationId: 'org_other',
        status: 'active',
      };
      const cursor = encodeCursor(position, otherOrgScope);

      const result = tryDecodeCursor(cursor, scope, isTestPosition);
      expect(result).toEqual({
        kind: 'mismatched',
        reason: 'Cursor does not match the requested scope',
      });
    });

    it('refuses a cursor minted against a different status as mismatched', () => {
      const position: TestPosition = { username: 'alice' };
      const otherStatusScope = {
        organizationId: 'org_acme',
        status: 'disabled',
      };
      const cursor = encodeCursor(position, otherStatusScope);

      const result = tryDecodeCursor(cursor, scope, isTestPosition);
      expect(result).toEqual({
        kind: 'mismatched',
        reason: 'Cursor does not match the requested scope',
      });
    });

    it('refuses a cursor with invalid position shape as malformed', () => {
      const badPos = Buffer.from(
        JSON.stringify({
          v: CURSOR_VERSION,
          pos: { invalid: 'field' },
          s: computeScopeHash(scope),
        }),
        'utf8',
      ).toString('base64url');
      const result = tryDecodeCursor(badPos, scope, isTestPosition);
      expect(result).toEqual({
        kind: 'malformed',
        reason: 'Cursor position is invalid',
      });
    });
  });

  describe('decodeCursor', () => {
    it('throws AppError with INVALID_REQUEST and details on malformed cursor', () => {
      let thrown: unknown;
      try {
        decodeCursor('invalid!cursor', scope, isTestPosition);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AppError);
      expect(thrown).toMatchObject({
        code: 'INVALID_REQUEST',
        httpStatus: 400,
        details: { cursor: 'Cursor contains invalid characters' },
      });
    });

    it('throws AppError with INVALID_REQUEST and details on mismatched cursor', () => {
      const cursor = encodeCursor(
        { username: 'alice' },
        { organizationId: 'org_other', status: 'active' },
      );

      let thrown: unknown;
      try {
        decodeCursor(cursor, scope, isTestPosition);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AppError);
      expect(thrown).toMatchObject({
        code: 'INVALID_REQUEST',
        httpStatus: 400,
        details: {
          cursor: 'Cursor does not match the requested scope',
        },
      });
    });

    it('throws AppError with INVALID_REQUEST and details on stale cursor version', () => {
      const stale = Buffer.from(
        JSON.stringify({
          v: 99,
          pos: { username: 'alice' },
          s: computeScopeHash(scope),
        }),
        'utf8',
      ).toString('base64url');

      let thrown: unknown;
      try {
        decodeCursor(stale, scope, isTestPosition);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AppError);
      expect(thrown).toMatchObject({
        code: 'INVALID_REQUEST',
        httpStatus: 400,
        details: {
          cursor: 'Cursor version 99 is not supported',
        },
      });
    });
  });
});
