import type { OrganizationMembershipMutationPort } from './organization-membership-mutation.port';
import {
  forbidden,
  requireActiveMembership,
} from './organization-membership.authorization';
import {
  ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL,
  type OrganizationMembershipMutationAction,
} from './organization-membership.mutation-policy';
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
    await this.authorize(input, 'change_role');
    return this.membership.changeRole(input);
  }

  async disable(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    await this.authorize(input, 'disable');
    return this.membership.disable(input);
  }

  async transfer(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    await this.authorize(input, 'transfer');
    return this.membership.transfer(input);
  }

  // Role authority depends on the target, so it is settled under the
  // repository's locks; this only turns away callers no role could admit.
  private async authorize(
    input: OrganizationMembershipMutationInput,
    action: OrganizationMembershipMutationAction,
  ): Promise<void> {
    const denial = ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL[action];
    const caller = await requireActiveMembership(
      this.membership,
      {
        context: input.context,
        userId: input.userId,
        organizationId: input.organizationId,
      },
      denial,
    );

    if (caller.organizationStatus === 'suspended') {
      throw forbidden(denial);
    }
  }
}
