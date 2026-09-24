import type { RequestContext } from '../../../common/request-context/request-context';

import type {
  ListedOrganizationMember,
  OrganizationMembershipListPort,
} from './organization-membership-list.port';
import { forbidden } from './organization-membership.authorization';
import type { OrganizationMembershipStatus } from './organization-membership.port';

const MEMBERSHIP_LIST_ACCESS_FORBIDDEN =
  'Organization membership list access is forbidden';

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
      throw forbidden(MEMBERSHIP_LIST_ACCESS_FORBIDDEN);
    }
    return result.members;
  }
}
