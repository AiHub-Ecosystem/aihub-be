import type { RequestContext } from '@/common/request-context/request-context';

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

export interface AcceptOrganizationInvitationInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly tokenHash: string;
  readonly now: Date;
}

export interface ListOpenOrganizationInvitationsInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly now: Date;
}

export interface RevokeOrganizationInvitationInput {
  readonly context: RequestContext;
  readonly actorUserId: string;
  readonly actorRole: OrganizationMembershipRole;
  readonly organizationId: string;
  readonly invitationId: string;
  readonly now: Date;
}

export type RevokeOrganizationInvitationResult =
  | { readonly kind: 'closed' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'organization_suspended' };

export interface OpenOrganizationInvitationRecord {
  readonly invitationId: string;
  readonly email: string;
  readonly role: OrganizationMembershipRole;
  readonly invitedByUsername: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * Every unusable token collapses into `token_invalid`, the wrong-account case
 * included: why a token failed stays inside the transaction so that holding one
 * never confirms whose invitation it is. No rejection consumes anything.
 */
export type AcceptOrganizationInvitationResult =
  | {
      readonly kind: 'accepted';
      readonly organizationId: string;
      readonly role: OrganizationMembershipRole;
    }
  | { readonly kind: 'token_invalid' }
  | { readonly kind: 'organization_suspended' };

export interface OrganizationInvitationPort {
  createInvitation(
    input: CreateOrganizationInvitationInput,
  ): Promise<CreateOrganizationInvitationResult>;
  listOpenInvitations(
    input: ListOpenOrganizationInvitationsInput,
  ): Promise<readonly OpenOrganizationInvitationRecord[]>;
  revokeInvitation(
    input: RevokeOrganizationInvitationInput,
  ): Promise<RevokeOrganizationInvitationResult>;
  acceptInvitation(
    input: AcceptOrganizationInvitationInput,
  ): Promise<AcceptOrganizationInvitationResult>;
}

export const ORGANIZATION_INVITATION = Symbol('ORGANIZATION_INVITATION');
