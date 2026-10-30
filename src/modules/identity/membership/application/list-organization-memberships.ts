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
  readonly after?: string;
  readonly limit: number;
}

export interface OrganizationMembershipPage {
  readonly members: readonly ListedOrganizationMember[];
  readonly next?: string;
}

export class ListOrganizationMemberships {
  constructor(private readonly membership: OrganizationMembershipListPort) {}

  async list(
    input: ListOrganizationMembershipsCommand,
  ): Promise<OrganizationMembershipPage> {
    const result = await this.membership.listOrganizationMembers({
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
      status: input.status,
      ...(input.after === undefined ? {} : { after: input.after }),
      limit: input.limit + 1,
    });
    if (result.kind === 'denied') {
      throw forbidden(ORGANIZATION_READ_ADMISSION.membership_list.refusal);
    }
    if (result.members.length <= input.limit) {
      return { members: result.members };
    }
    const members = result.members.slice(0, input.limit);
    const last = members[members.length - 1];
    return {
      members,
      ...(last === undefined ? {} : { next: last.username }),
    };
  }
}
