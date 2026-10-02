import { AppError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';

import type { OrganizationInvitationPort } from './organization-invitation.port';
import {
  forbidden,
  requireActiveMembership,
} from './organization-membership.authorization';
import type { OrganizationMembershipPort } from './organization-membership.port';

const INVITATION_REVOCATION_FORBIDDEN =
  'Organization invitation revocation is forbidden';

export interface RevokeOrganizationInvitationCommand {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly invitationId: string;
}

/**
 * Closes one Organization Invitation. An already closed or expired invitation
 * is a successful retry, while the repository owns target authorization under
 * the same row lock as the durable close.
 */
export class RevokeOrganizationInvitation {
  constructor(
    private readonly membership: Pick<
      OrganizationMembershipPort,
      'resolveMembership'
    >,
    private readonly invitations: Pick<
      OrganizationInvitationPort,
      'revokeInvitation'
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async revoke(input: RevokeOrganizationInvitationCommand): Promise<void> {
    const caller = await requireActiveMembership(
      this.membership,
      {
        context: input.context,
        userId: input.userId,
        organizationId: input.organizationId,
      },
      INVITATION_REVOCATION_FORBIDDEN,
    );

    if (caller.organizationStatus === 'suspended') {
      throw forbidden(INVITATION_REVOCATION_FORBIDDEN);
    }

    const result = await this.invitations.revokeInvitation({
      context: input.context,
      actorUserId: input.userId,
      actorRole: caller.role,
      organizationId: input.organizationId,
      invitationId: input.invitationId,
      now: this.now(),
    });

    if (result.kind === 'not_found') {
      if (caller.role === 'member') {
        throw forbidden(INVITATION_REVOCATION_FORBIDDEN);
      }
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Organization invitation was not found',
        retryable: false,
      });
    }

    if (result.kind === 'organization_suspended') {
      throw forbidden(INVITATION_REVOCATION_FORBIDDEN);
    }
  }
}
