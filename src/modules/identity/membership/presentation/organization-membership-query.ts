import { isRecord } from '@/common/is-record';
import type { OrganizationMembershipListQuery } from '@/contracts/organization/membership';
import type { OrganizationMembershipStatus } from '@/modules/identity/membership/application/organization-membership.port';
import { decodeCursor } from '@/modules/identity/shared/presentation/cursor-codec';
import { parsePageLimit } from '@/modules/identity/shared/presentation/page-limit';

export interface MemberCursorPosition {
  readonly username: string;
}

export function isMemberCursorPosition(
  value: unknown,
): value is MemberCursorPosition {
  return (
    isRecord(value) &&
    typeof value.username === 'string' &&
    value.username.length > 0
  );
}

export interface OrganizationMembershipQuery {
  readonly status: OrganizationMembershipStatus;
  readonly after?: string;
  readonly limit: number;
}

export function parseOrganizationMembershipQuery(
  query: OrganizationMembershipListQuery,
  organizationId: string,
): OrganizationMembershipQuery {
  const status: OrganizationMembershipStatus = query.status ?? 'active';
  const limit = parsePageLimit(query.limit);

  if (query.cursor === undefined) {
    return { status, limit };
  }

  const position = decodeCursor(
    query.cursor,
    { organizationId, status },
    isMemberCursorPosition,
  );

  return { status, after: position.username, limit };
}
