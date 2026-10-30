import { isRecord } from '@/common/is-record';
import type { OrganizationRosterQuery } from '@/contracts/organization/membership';
import {
  DEFAULT_ROSTER_PAGE_SIZE,
  MAX_ROSTER_PAGE_SIZE,
} from '@/contracts/organization/pagination';
import { decodeCursor } from '@/modules/identity/shared/presentation/cursor-codec';
import { parsePageLimit } from '@/modules/identity/shared/presentation/page-limit';

export interface RosterCursorPosition {
  readonly organizationId: string;
}

export function isRosterCursorPosition(
  value: unknown,
): value is RosterCursorPosition {
  return (
    isRecord(value) &&
    typeof value.organizationId === 'string' &&
    value.organizationId.length > 0
  );
}

/** The roster has no Organization in its path, so its cursor is bound to the caller. */
export function rosterCursorScope(userId: string): { readonly userId: string } {
  return { userId };
}

export interface ParsedRosterQuery {
  readonly after?: string;
  readonly limit: number;
}

export function parseOrganizationRosterQuery(
  query: OrganizationRosterQuery,
  userId: string,
): ParsedRosterQuery {
  const limit = parsePageLimit(query.limit, {
    defaultSize: DEFAULT_ROSTER_PAGE_SIZE,
    maxSize: MAX_ROSTER_PAGE_SIZE,
  });

  if (query.cursor === undefined) {
    return { limit };
  }

  const position = decodeCursor(
    query.cursor,
    rosterCursorScope(userId),
    isRosterCursorPosition,
  );
  return { after: position.organizationId, limit };
}
