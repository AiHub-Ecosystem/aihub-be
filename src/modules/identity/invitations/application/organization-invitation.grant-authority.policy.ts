import type { OrganizationMembershipRole } from '@/modules/identity/membership/application/organization-membership.port';

export interface OrganizationInvitationGrantAuthorityInput {
  /** The Membership Role of the inviter (or accepting invitation's issuer). */
  readonly callerRole: OrganizationMembershipRole | undefined;
  /** The Membership Role the invitation would grant. */
  readonly invitedRole: OrganizationMembershipRole;
}

/**
 * Whether a caller with `callerRole` may issue an invitation granting
 * `invitedRole`. Owners may grant any role; admins may grant `member` only;
 * members and non-members may grant nothing.
 *
 * This is the same rule the send path applies before its transaction
 * (`InviteOrganizationMember`). Evaluating it again against the inviter's
 * *current* role — under the row locks of the send or acceptance transaction —
 * is what keeps a pending invitation from outliving the inviter's authority
 * (ADR-0027 as amended, #447).
 */
export function mayGrantInvitationRole(
  input: OrganizationInvitationGrantAuthorityInput,
): boolean {
  if (input.callerRole === 'owner') return true;
  return input.callerRole === 'admin' && input.invitedRole === 'member';
}
