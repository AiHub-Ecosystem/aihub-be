import { isRecord } from '@/common/is-record';
import type {
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
} from '@/modules/identity/membership/application/organization-membership.port';
import {
  membershipRoleValue,
  membershipStatusValue,
} from '@/modules/identity/shared/infrastructure/identity-row';

/**
 * The inviter's or caller's current Membership, as one row of
 * `organization_members`. Send and revoke lock it `FOR UPDATE` because what
 * follows from the read is a write they commit; acceptance takes it `FOR
 * SHARE`, which is enough to hold the row stable against a concurrent disable
 * or demotion while the grant, the token consumption, and the applied event
 * commit (ADR-0159, decision 2). Every statement selects `status AS
 * membership_status` explicitly: the reader consumes the aliased name, so an
 * unaliased `status` column would read as `undefined` and refuse everyone.
 */
export const SHARE_MEMBERSHIP_AUTHORITY_SQL = `
  SELECT role, status AS membership_status
  FROM organization_members
  WHERE organization_id = $1
    AND user_account_id = $2
  FOR SHARE
`;

export const LOCK_MEMBERSHIP_AUTHORITY_SQL = `
  SELECT role, status AS membership_status
  FROM organization_members
  WHERE organization_id = $1
    AND user_account_id = $2
  FOR UPDATE
`;

/** A Membership Role and Status as one locked row reports them. */
export interface MembershipAuthority {
  readonly role: OrganizationMembershipRole;
  readonly status: OrganizationMembershipStatus;
}

export function membershipAuthority(
  value: unknown,
): MembershipAuthority | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const role = membershipRoleValue(value, 'role');
  const status = membershipStatusValue(value, 'membership_status');
  return role === undefined || status === undefined
    ? undefined
    : { role, status };
}
