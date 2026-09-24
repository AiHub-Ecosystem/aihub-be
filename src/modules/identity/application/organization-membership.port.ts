import type { RequestContext } from '../../../common/request-context/request-context';
import type { OrganizationStatus } from './api-key-authenticator.port';

export type OrganizationMembershipMutationRole = 'admin' | 'member';

export interface OrganizationMembershipMutationInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly username: string;
}

export interface ChangeOrganizationMemberRoleInput
  extends OrganizationMembershipMutationInput {
  readonly role: OrganizationMembershipMutationRole;
}

export interface OrganizationMembershipMutationResult {
  readonly organizationId: string;
  readonly username: string;
  readonly role: OrganizationMembershipRole;
  readonly status: OrganizationMembershipStatus;
}

export type OrganizationMembershipRole = 'owner' | 'admin' | 'member';
export type OrganizationMembershipStatus = 'active' | 'disabled';

export interface OrganizationMembershipRecord {
  readonly organizationId: string;
  readonly userId: string;
  readonly organizationStatus: OrganizationStatus;
  readonly role: OrganizationMembershipRole;
  readonly status: OrganizationMembershipStatus;
}

export interface ResolveMembershipInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
}

export interface ListRosterInput {
  readonly context: RequestContext;
  readonly userId: string;
}

export type OrganizationMembershipResolution =
  | {
      readonly kind: 'active';
      readonly membership: OrganizationMembershipRecord;
    }
  | {
      readonly kind: 'disabled';
      readonly membership: OrganizationMembershipRecord;
    }
  | { readonly kind: 'missing' };

export interface OrganizationRosterMember {
  readonly username: string;
  readonly role: OrganizationMembershipRole;
}

export interface OrganizationRosterOrganization {
  readonly organizationId: string;
  readonly name: string;
  readonly status: OrganizationStatus;
  readonly entitlements: readonly string[];
  readonly membershipRole: OrganizationMembershipRole;
  readonly members: readonly OrganizationRosterMember[];
}

export interface OrganizationMembershipPort {
  resolveMembership(
    input: ResolveMembershipInput,
  ): Promise<OrganizationMembershipResolution>;
  listRoster(
    input: ListRosterInput,
  ): Promise<readonly OrganizationRosterOrganization[]>;
  changeRole(
    input: ChangeOrganizationMemberRoleInput,
  ): Promise<OrganizationMembershipMutationResult>;
  disable(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult>;
  transfer(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult>;
}

export const ORGANIZATION_MEMBERSHIP = Symbol('ORGANIZATION_MEMBERSHIP');
