import { AppError } from '@/common/errors/app-error';
import {
  DEFAULT_COLLECTION_PAGE_SIZE,
  MAX_COLLECTION_PAGE_SIZE,
} from '@/contracts/organization/pagination';

import { parsePageLimit } from './page-limit';

function refusal(value: string): AppError {
  try {
    parsePageLimit(value);
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error(`limit ${value} was accepted`);
}

describe('parsePageLimit', () => {
  it('takes the default when the limit is absent', () => {
    expect(parsePageLimit(undefined)).toBe(DEFAULT_COLLECTION_PAGE_SIZE);
  });

  it('accepts the bounds of the range', () => {
    expect(parsePageLimit('1')).toBe(1);
    expect(parsePageLimit(String(MAX_COLLECTION_PAGE_SIZE))).toBe(
      MAX_COLLECTION_PAGE_SIZE,
    );
  });

  it.each(['0', String(MAX_COLLECTION_PAGE_SIZE + 1)])(
    'refuses %s instead of clamping it',
    (value) => {
      const error = refusal(value);

      expect(error.code).toBe('INVALID_REQUEST');
      expect(error.details).toEqual({
        limit: `Limit must be between 1 and ${MAX_COLLECTION_PAGE_SIZE}`,
      });
    },
  );

  it.each(['abc', '1.5', '-1', '', ' 5', '5 '])(
    'refuses the non-integer value "%s"',
    (value) => {
      const error = refusal(value);

      expect(error.code).toBe('INVALID_REQUEST');
      expect(error.details).toEqual({
        limit: 'Limit must be an integer string',
      });
    },
  );
});
