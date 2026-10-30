import { invalidRequest } from '@/common/errors/invalid-request';
import {
  DEFAULT_COLLECTION_PAGE_SIZE,
  MAX_COLLECTION_PAGE_SIZE,
} from '@/contracts/organization/pagination';

/**
 * Reads the `limit` query value of a paginated collection (ADR-0130). An absent
 * value takes the default; a value outside the range is refused rather than
 * clamped, because a silently shortened page looks like the end of the
 * collection.
 */
export function parsePageLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_COLLECTION_PAGE_SIZE;
  }
  if (!/^\d+$/.test(value)) {
    throw invalidRequest(
      undefined,
      { limit: 'Limit must be an integer string' },
      'Invalid page limit format',
    );
  }

  const limit = Number.parseInt(value, 10);
  if (limit < 1 || limit > MAX_COLLECTION_PAGE_SIZE) {
    throw invalidRequest(
      undefined,
      { limit: `Limit must be between 1 and ${MAX_COLLECTION_PAGE_SIZE}` },
      'Page limit out of bounds',
    );
  }

  return limit;
}
