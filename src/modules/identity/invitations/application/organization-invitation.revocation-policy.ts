import type { OrganizationMembershipRole } from '@/modules/identity/membership/application/organization-membership.port';

export interface OrganizationInvitationRevocationPolicyInput {
  readonly actorRole: OrganizationMembershipRole;
  readonly invitedRole: OrganizationMembershipRole;
}

/**
 * Whether the actor may close an invitation that names `invitedRole`. Owners
 * close any invitation, admins only those for a member, members none. The
 * repository evaluates this under its row locks; it does not own the rule.
 */
export function mayRevokeOrganizationInvitation(
  input: OrganizationInvitationRevocationPolicyInput,
): boolean {
  if (input.actorRole === 'owner') return true;
  return input.actorRole === 'admin' && input.invitedRole === 'member';
}
