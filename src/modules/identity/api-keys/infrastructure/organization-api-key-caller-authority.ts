import { isRecord } from '@/common/is-record';
import {
  ORGANIZATION_API_KEY_ADMISSION,
  type OrganizationApiKeySurface,
} from '@/modules/identity/membership/application/organization-admission';
import {
  type OrganizationMembershipRole,
  type OrganizationMembershipStatus,
} from '@/modules/identity/membership/application/organization-membership.port';
import type { OrganizationStatus } from '@/modules/identity/organizations/application/organization-status.port';
import {
  membershipRoleValue,
  membershipStatusValue,
  organizationStatusValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import { identityRows } from '@/modules/identity/shared/infrastructure/postgres-identity.client';

/**
 * ADR-0027 as amended: a key mutation decides the caller's authority before it opens its
 * transaction and again under the same Organization lock the mutation writes
 * through. The read before the transaction admits a caller whose Membership
 * then changes; this read is what refuses it, so a rotate that serializes after
 * a disable cannot hand out a replacement credential.
 *
 * The decision itself is the admission table's, not a second rule: an active
 * owner or admin of an active Organization. The repository only supplies the
 * rows it locked.
 */
export const LOCK_CALLER_MEMBERSHIP_SQL = `
  SELECT
    organization.status AS organization_status,
    membership.role,
    membership.status AS membership_status
  FROM organizations AS organization
  LEFT JOIN organization_members AS membership
    ON membership.organization_id = organization.id
   AND membership.user_account_id = $2
  WHERE organization.id = $1
  FOR UPDATE OF organization
`;

/**
 * The caller's authority as the locked rows report it.
 */
export interface LockedCallerAuthority {
  readonly role: OrganizationMembershipRole;
  readonly status: OrganizationMembershipStatus;
  readonly organizationStatus: OrganizationStatus;
}

export function lockedCallerAuthority(
  value: unknown,
): LockedCallerAuthority | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const role = membershipRoleValue(value, 'role');
  const status = membershipStatusValue(value, 'membership_status');
  const organizationStatus = organizationStatusValue(
    value,
    'organization_status',
  );
  return role === undefined ||
    status === undefined ||
    organizationStatus === undefined
    ? undefined
    : { role, status, organizationStatus };
}

/**
 * True only when the locked rows still admit the caller to this key surface.
 * Anything else — a disabled or demoted caller, a suspended Organization, or a
 * projection that cannot be read — is a refusal.
 */
export function callerRetainsApiKeyAuthority(
  authority: LockedCallerAuthority | undefined,
  surface: OrganizationApiKeySurface,
): boolean {
  if (authority === undefined) {
    return false;
  }

  const rule = ORGANIZATION_API_KEY_ADMISSION[surface];
  if (authority.status !== 'active') {
    return false;
  }
  if (!rule.admittedRoles.includes(authority.role)) {
    return false;
  }
  return !(
    rule.suspensionClosesSurface && authority.organizationStatus !== 'active'
  );
}

/**
 * Re-reads the caller's Membership and the Organization status under the
 * Organization lock the mutation already holds. The read before the
 * transaction admitted a caller whose Membership can change while the
 * transaction waits for this lock, and only this one decides. A missing
 * Membership and a disabled one are the same refusal.
 */
export async function callerRetainsAuthority(
  transaction: Parameters<typeof identityRows>[0],
  organizationId: string,
  actorUserId: string,
  surface: OrganizationApiKeySurface,
): Promise<boolean> {
  const rows = await identityRows(transaction, LOCK_CALLER_MEMBERSHIP_SQL, [
    organizationId,
    actorUserId,
  ]);
  return callerRetainsApiKeyAuthority(lockedCallerAuthority(rows[0]), surface);
}
