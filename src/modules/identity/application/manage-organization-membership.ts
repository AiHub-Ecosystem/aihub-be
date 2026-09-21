import type { OrganizationMembershipMutationPort } from './organization-membership-mutation.port';
import {
  forbidden,
  requireActiveMembership,
} from './organization-membership.authorization';
import type {
  ChangeOrganizationMemberRoleInput,
  OrganizationMembershipMutationInput,
  OrganizationMembershipMutationResult,
  OrganizationMembershipPort,
} from './organization-membership.port';

export class ManageOrganizationMembership
  implements OrganizationMembershipMutationPort
{
  constructor(
    private readonly membership: Pick<
      OrganizationMembershipPort,
      'resolveMembership' | 'changeRole' | 'disable' | 'transfer'
    >,
  ) {}

  async changeRole(
    input: ChangeOrganizationMemberRoleInput,
  ): Promise<OrganizationMembershipMutationResult> {
    await this.authorize(input);
    return this.membership.changeRole(input);
  }

  async disable(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    await this.authorize(input);
    return this.membership.disable(input);
  }

  async transfer(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    await this.authorize(input);
    return this.membership.transfer(input);
  }

  private async authorize(
    input: OrganizationMembershipMutationInput,
  ): Promise<void> {
    const caller = await requireActiveMembership(this.membership, {
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
    });

    if (caller.organizationStatus === 'suspended') {
      throw forbidden('Organization is suspended');
    }
  }
}
