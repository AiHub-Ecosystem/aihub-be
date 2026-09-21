import { AppError } from '../../../common/errors/app-error';
import type { RequestContext } from '../../../common/request-context/request-context';

import type {
  OpenOrganizationInvitationRecord,
  OrganizationInvitationPort,
} from './organization-invitation.port';
import { requireActiveMembership } from './organization-membership.authorization';
import type { OrganizationMembershipPort } from './organization-membership.port';

export interface ListOpenOrganizationInvitationsCommand {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly now: Date;
}

export type ListedOrganizationInvitation = OpenOrganizationInvitationRecord & {
  readonly status: 'pending';
};

function forbidden(message: string): AppError {
  return new AppError({ code: 'FORBIDDEN', message, retryable: false });
}

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
  ): Promise<readonly ListedOrganizationInvitation[]> {
    const caller = await requireActiveMembership(this.membership, {
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
    });

    if (caller.organizationStatus === 'suspended') {
      throw forbidden('Organization is suspended');
    }

    if (caller.role === 'member') {
      throw forbidden('Organization membership role cannot list invitations');
    }

    const records = await this.invitations.listOpenInvitations({
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
      now: input.now,
    });

    return records.map((record) => ({ ...record, status: 'pending' }));
  }
}
