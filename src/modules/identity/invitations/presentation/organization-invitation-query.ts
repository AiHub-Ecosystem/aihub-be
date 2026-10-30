import { isRecord } from '@/common/is-record';
import type { ListOpenOrganizationInvitationsQuery } from '@/contracts/organization/invitation';
import { decodeCursor } from '@/modules/identity/shared/presentation/cursor-codec';
import { parsePageLimit } from '@/modules/identity/shared/presentation/page-limit';

export interface InvitationCursorPosition {
  readonly createdAt: string;
  readonly id: string;
}

/** The server mints `createdAt` with `toISOString`, so only that exact form is a position. */
function isMintedTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

export function isInvitationCursorPosition(
  value: unknown,
): value is InvitationCursorPosition {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    isMintedTimestamp(value.createdAt)
  );
}

export interface OrganizationInvitationQuery {
  readonly after?: {
    readonly createdAt: Date;
    readonly id: string;
  };
  readonly limit: number;
}

export function parseOrganizationInvitationQuery(
  query: ListOpenOrganizationInvitationsQuery,
  organizationId: string,
): OrganizationInvitationQuery {
  const limit = parsePageLimit(query.limit);

  if (query.cursor === undefined) {
    return { limit };
  }

  const position = decodeCursor(
    query.cursor,
    { organizationId },
    isInvitationCursorPosition,
  );

  return {
    after: { createdAt: new Date(position.createdAt), id: position.id },
    limit,
  };
}
