import type {
  ListOrganizationMembersInput,
  OrganizationMembershipListPort,
  OrganizationMembershipListResult,
} from '@/modules/identity/membership/application/organization-membership-list.port';
import type {
  ChangeOrganizationMemberRoleInput,
  ListRosterInput,
  OrganizationMembershipMutationInput,
  OrganizationMembershipMutationResult,
  OrganizationMembershipPort,
  OrganizationMembershipResolution,
  OrganizationRosterOrganization,
  ResolveMembershipInput,
} from '@/modules/identity/membership/application/organization-membership.port';
import type { IdentityRepositoryClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import { PostgresOrganizationMembershipMutationRepository } from './postgres-organization-membership-mutation.repository';
import { PostgresOrganizationMembershipReadRepository } from './postgres-organization-membership-read.repository';

export {
  RESOLVE_MEMBERSHIP_SQL,
  LIST_ROSTER_SQL,
  LIST_ORGANIZATION_MEMBERS_SQL,
  admittedRoles,
} from './postgres-organization-membership-read.repository';

export class PostgresOrganizationMembershipRepository
  implements OrganizationMembershipPort, OrganizationMembershipListPort
{
  private readonly reads: PostgresOrganizationMembershipReadRepository;
  private readonly mutations: PostgresOrganizationMembershipMutationRepository;

  constructor(private readonly client: IdentityRepositoryClient) {
    this.reads = new PostgresOrganizationMembershipReadRepository(client);
    this.mutations = new PostgresOrganizationMembershipMutationRepository(
      client,
    );
  }

  resolveMembership(
    input: ResolveMembershipInput,
  ): Promise<OrganizationMembershipResolution> {
    return this.reads.resolveMembership(input);
  }

  listRoster(
    input: ListRosterInput,
  ): Promise<readonly OrganizationRosterOrganization[]> {
    return this.reads.listRoster(input);
  }

  listOrganizationMembers(
    input: ListOrganizationMembersInput,
  ): Promise<OrganizationMembershipListResult> {
    return this.reads.listOrganizationMembers(input);
  }

  changeRole(
    input: ChangeOrganizationMemberRoleInput,
  ): Promise<OrganizationMembershipMutationResult> {
    return this.mutations.changeRole(input);
  }

  disable(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    return this.mutations.disable(input);
  }

  transfer(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    return this.mutations.transfer(input);
  }

  async onModuleDestroy(): Promise<void> {
    if ('close' in this.client && typeof this.client.close === 'function') {
      await this.client.close();
    }
  }
}
