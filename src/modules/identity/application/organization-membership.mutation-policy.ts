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

/**
 * Each route's Safe Authorization Denial. Raised by the use case and, for
 * checks that only the locked transaction can settle, by the repository.
 */
export const ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL: Readonly<
  Record<OrganizationMembershipMutationAction, string>
> = {
  change_role: 'Organization membership role change is forbidden',
  disable: 'Organization membership disable is forbidden',
  transfer: 'Organization ownership transfer is forbidden',
};

/**
 * Refusals for a caller who does hold authority on the route, about the
 * target they named. They keep specific reasons: the caller has proved they
 * belong, and can already read the roster these reasons describe.
 */
export const ORGANIZATION_MEMBERSHIP_TARGET_REFUSAL: Readonly<
  Record<OrganizationMembershipMutationAction, string>
> = {
  change_role: 'Organization admins can only manage members',
  disable: 'Organization admins can only manage members',
  transfer: 'Ownership can only be transferred to a non-owner member',
};

export interface OrganizationMembershipRouteAuthorityInput {
  readonly action: OrganizationMembershipMutationAction;
  readonly callerRole: OrganizationMembershipRole;
  readonly targetIsCaller: boolean;
}

/**
 * Whether the caller holds authority on the route at all, decided from the
 * route and their own role alone, before any target is looked up. Owners and
 * admins may change roles; they, and anyone acting on their own membership,
 * may disable; only owners may transfer. A caller without it gets the route's
 * Safe Authorization Denial whether or not the named target exists.
 */
export function hasOrganizationMembershipRouteAuthority(
  input: OrganizationMembershipRouteAuthorityInput,
): boolean {
  switch (input.action) {
    case 'change_role':
      return input.callerRole !== 'member';
    case 'disable':
      return input.callerRole !== 'member' || input.targetIsCaller;
    case 'transfer':
      return input.callerRole === 'owner';
  }
}

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
