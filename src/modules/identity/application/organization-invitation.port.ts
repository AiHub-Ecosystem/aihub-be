import type { RequestContext } from '../../../common/request-context/request-context';

import type { OrganizationMembershipRole } from './organization-membership.port';

export interface CreateOrganizationInvitationInput {
  readonly context: RequestContext;
  readonly invitationId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: OrganizationMembershipRole;
  readonly invitedBy: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

/**
 * `member_exists` is resolved inside the same transaction as the insert, so a
 * membership that becomes active concurrently cannot slip past the check.
 */
export type CreateOrganizationInvitationResult =
  | {
      readonly kind: 'created';
      readonly organizationName: string;
    }
  | { readonly kind: 'member_exists' };

export interface OrganizationInvitationPort {
  createInvitation(
    input: CreateOrganizationInvitationInput,
  ): Promise<CreateOrganizationInvitationResult>;
}

export const ORGANIZATION_INVITATION = Symbol('ORGANIZATION_INVITATION');
