import type {
  OrganizationMembershipMutationRole,
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
} from './organization-membership.port';

export type OrganizationMembershipMutationAction =
  | 'change_role'
  | 'disable'
  | 'transfer';

export interface OrganizationMembershipMutationPolicyInput {
  readonly action: OrganizationMembershipMutationAction;
  readonly callerUserId: string;
  readonly callerRole: OrganizationMembershipRole;
  readonly targetUserId: string;
  readonly targetRole: OrganizationMembershipRole;
  readonly targetStatus: OrganizationMembershipStatus;
  readonly requestedRole?: OrganizationMembershipMutationRole;
}

export type OrganizationMembershipMutationPolicyDecision =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'target_unavailable' }
  | { readonly kind: 'invalid' };

export function authorizeOrganizationMembershipMutation(
  input: OrganizationMembershipMutationPolicyInput,
): OrganizationMembershipMutationPolicyDecision {
  const callerIsTarget = input.callerUserId === input.targetUserId;

  if (input.action === 'disable') {
    if (callerIsTarget) {
      return { kind: 'allowed' };
    }
    if (input.callerRole === 'member') {
      return { kind: 'forbidden' };
    }
    if (input.callerRole === 'admin' && input.targetRole !== 'member') {
      return { kind: 'forbidden' };
    }
    return { kind: 'allowed' };
  }

  if (input.targetStatus !== 'active') {
    return { kind: 'target_unavailable' };
  }

  if (input.action === 'transfer') {
    if (
      input.callerRole !== 'owner' ||
      callerIsTarget ||
      input.targetRole === 'owner'
    ) {
      return { kind: 'forbidden' };
    }
    return { kind: 'allowed' };
  }

  if (input.requestedRole === undefined) {
    return { kind: 'invalid' };
  }
  if (input.callerRole === 'member') {
    return { kind: 'forbidden' };
  }
  if (input.callerRole === 'admin' && input.targetRole !== 'member') {
    return { kind: 'forbidden' };
  }

  return { kind: 'allowed' };
}
