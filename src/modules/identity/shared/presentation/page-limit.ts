import { invalidRequest } from '@/common/errors/invalid-request';
import {
  DEFAULT_COLLECTION_PAGE_SIZE,
  MAX_COLLECTION_PAGE_SIZE,
} from '@/contracts/organization/pagination';

export interface PageLimitBounds {
  readonly defaultSize: number;
  readonly maxSize: number;
}

const COLLECTION_PAGE_BOUNDS: PageLimitBounds = {
  defaultSize: DEFAULT_COLLECTION_PAGE_SIZE,
  maxSize: MAX_COLLECTION_PAGE_SIZE,
};

/**
 * Reads the `limit` query value of a paginated collection (ADR-0130; the
 * cross-Organization roster passes its own, smaller bounds, ADR-0133). An absent
 * value takes the default; a value outside the range is refused rather than
 * clamped, because a silently shortened page looks like the end of the
 * collection.
 */
export function parsePageLimit(
  value: string | undefined,
  bounds: PageLimitBounds = COLLECTION_PAGE_BOUNDS,
): number {
  if (value === undefined) {
    return bounds.defaultSize;
  }
  if (!/^\d+$/.test(value)) {
    throw invalidRequest(
      undefined,
      { limit: 'Limit must be an integer string' },
      'Invalid page limit format',
    );
  }

  const limit = Number.parseInt(value, 10);
  if (limit < 1 || limit > bounds.maxSize) {
    throw invalidRequest(
      undefined,
      { limit: `Limit must be between 1 and ${bounds.maxSize}` },
      'Page limit out of bounds',
    );
  }

  return limit;
}
