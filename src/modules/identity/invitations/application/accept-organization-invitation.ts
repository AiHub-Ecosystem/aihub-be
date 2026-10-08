import { AppError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';

import type { OrganizationMembershipRole } from '@/modules/identity/membership/application/organization-membership.port';
import type { OrganizationInvitationPort } from './organization-invitation.port';
import type { OrganizationInviteTokenPort } from './organization-invite-token.port';

export interface AcceptOrganizationInvitationCommand {
  readonly context: RequestContext;
  readonly userId: string;
  readonly token: string;
}

export interface AcceptedOrganizationInvitation {
  readonly organizationId: string;
  readonly role: OrganizationMembershipRole;
}

/**
 * Redeems one Organization Invite Token for the authenticated account.
 *
 * The organization is an attribute of the invitation, never a request
 * parameter, so this use case takes no organization: there is nothing for a
 * caller to name, and therefore nothing to mismatch.
 */
export class AcceptOrganizationInvitation {
  constructor(
    private readonly invitations: Pick<
      OrganizationInvitationPort,
      'acceptInvitation'
    >,
    private readonly inviteToken: Pick<OrganizationInviteTokenPort, 'hash'>,
  ) {}

  async accept(
    command: AcceptOrganizationInvitationCommand,
  ): Promise<AcceptedOrganizationInvitation> {
    const result = await this.invitations.acceptInvitation({
      context: command.context,
      userId: command.userId,
      tokenHash: this.inviteToken.hash(command.token),
      now: new Date(),
    });

    if (result.kind === 'organization_suspended') {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Organization is suspended',
        retryable: false,
      });
    }

    if (result.kind === 'token_invalid') {
      // One result for unknown, malformed, expired, consumed, superseded, and
      // wrong-account tokens: the response must not tell a token holder which
      // of those they are looking at.
      throw new AppError({
        code: 'ORGANIZATION_INVITE_TOKEN_INVALID',
        message: 'Invitation token is invalid',
        retryable: false,
      });
    }

    return { organizationId: result.organizationId, role: result.role };
  }
}
