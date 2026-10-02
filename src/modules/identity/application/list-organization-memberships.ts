import type { RequestContext } from '@/common/request-context/request-context';

import { ORGANIZATION_READ_ADMISSION } from './organization-admission';
import type {
  ListedOrganizationMember,
  OrganizationMembershipListPort,
} from './organization-membership-list.port';
import { forbidden } from './organization-membership.authorization';
import type { OrganizationMembershipStatus } from './organization-membership.port';

export interface ListOrganizationMembershipsCommand {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly status: OrganizationMembershipStatus;
}

export class ListOrganizationMemberships {
  constructor(private readonly membership: OrganizationMembershipListPort) {}

  async list(
    input: ListOrganizationMembershipsCommand,
  ): Promise<readonly ListedOrganizationMember[]> {
    const result = await this.membership.listOrganizationMembers(input);
    if (result.kind === 'denied') {
      throw forbidden(ORGANIZATION_READ_ADMISSION.membership_list.refusal);
    }
    return result.members;
  }
}
