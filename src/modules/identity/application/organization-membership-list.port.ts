import type { RequestContext } from '../../../common/request-context/request-context';

import type {
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
} from './organization-membership.port';

export interface ListOrganizationMembersInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly status: OrganizationMembershipStatus;
}

export interface ListedOrganizationMember {
  readonly username: string;
  readonly role: OrganizationMembershipRole;
  readonly status: OrganizationMembershipStatus;
}

export type OrganizationMembershipListResult =
  | {
      readonly kind: 'authorized';
      readonly members: readonly ListedOrganizationMember[];
    }
  | { readonly kind: 'denied' };

export interface OrganizationMembershipListPort {
  listOrganizationMembers(
    input: ListOrganizationMembersInput,
  ): Promise<OrganizationMembershipListResult>;
}

export const ORGANIZATION_MEMBERSHIP_LIST = Symbol(
  'ORGANIZATION_MEMBERSHIP_LIST',
);
