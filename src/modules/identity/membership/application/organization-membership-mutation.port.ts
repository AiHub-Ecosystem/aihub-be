import type {
  ChangeOrganizationMemberRoleInput,
  OrganizationMembershipMutationInput,
  OrganizationMembershipMutationResult,
} from './organization-membership.port';

export interface OrganizationMembershipMutationPort {
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

export const ORGANIZATION_MEMBERSHIP_MUTATION = Symbol(
  'ORGANIZATION_MEMBERSHIP_MUTATION',
);
