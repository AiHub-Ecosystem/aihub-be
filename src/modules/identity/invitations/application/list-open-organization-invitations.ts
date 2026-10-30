import type { RequestContext } from '@/common/request-context/request-context';

import { admitOrganizationRead } from '@/modules/identity/membership/application/organization-admission';
import type { OrganizationMembershipPort } from '@/modules/identity/membership/application/organization-membership.port';
import type {
  OpenOrganizationInvitationRecord,
  OrganizationInvitationPort,
} from './organization-invitation.port';

export interface ListOpenOrganizationInvitationsCommand {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly now: Date;
  readonly after?: {
    readonly createdAt: Date;
    readonly id: string;
  };
  readonly limit: number;
}

export interface OpenOrganizationInvitationCursorPosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface OpenOrganizationInvitationPage {
  readonly invitations: readonly ListedOrganizationInvitation[];
  readonly next?: OpenOrganizationInvitationCursorPosition;
}

export type ListedOrganizationInvitation = OpenOrganizationInvitationRecord & {
  readonly status: 'pending';
};

/**
 * Reads an Organization's actionable invitations for an authorized owner or
 * admin. The repository owns the durable filter and stable ordering; this
 * use case owns the membership policy and public pending projection.
 */
export class ListOpenOrganizationInvitations {
  constructor(
    private readonly membership: Pick<
      OrganizationMembershipPort,
      'resolveMembership'
    >,
    private readonly invitations: Pick<
      OrganizationInvitationPort,
      'listOpenInvitations'
    >,
  ) {}

  async list(
    input: ListOpenOrganizationInvitationsCommand,
  ): Promise<OpenOrganizationInvitationPage> {
    const admission = await admitOrganizationRead(this.membership, {
      surface: 'open_invitations',
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
    });
    if (!admission.admitted) {
      throw admission.refusal;
    }

    const records = await this.invitations.listOpenInvitations({
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
      now: input.now,
      ...(input.after === undefined ? {} : { after: input.after }),
      limit: input.limit + 1,
    });

    const hasNext = records.length > input.limit;
    const pageRecords = hasNext ? records.slice(0, input.limit) : records;
    const invitations = pageRecords.map((record) => ({
      ...record,
      status: 'pending' as const,
    }));

    if (!hasNext) {
      return { invitations };
    }

    const last = pageRecords[pageRecords.length - 1];
    return {
      invitations,
      ...(last === undefined
        ? {}
        : {
            next: {
              createdAt: last.createdAt.toISOString(),
              id: last.invitationId,
            },
          }),
    };
  }
}
