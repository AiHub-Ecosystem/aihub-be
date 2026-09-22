import { AppError } from '../../../common/errors/app-error';
import { invalidRequest } from '../../../common/errors/invalid-request';
import type { RequestContext } from '../../../common/request-context/request-context';
import type { EmailSenderPort } from '../../auth/application/email-sender.port';
import { normalizeEmail } from '../../auth/domain/local-auth';

import type { OrganizationInvitationPort } from './organization-invitation.port';
import type { OrganizationInviteTokenPort } from './organization-invite-token.port';
import {
  forbidden,
  requireActiveMembership,
} from './organization-membership.authorization';
import type {
  OrganizationMembershipPort,
  OrganizationMembershipRole,
} from './organization-membership.port';

export interface InviteOrganizationMemberInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: OrganizationMembershipRole;
}

export interface InvitedOrganizationMember {
  readonly invitationId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: OrganizationMembershipRole;
  readonly expiresAt: Date;
}

/**
 * Invites one normalized email to an Organization as an Organization
 * Invitation: no membership row exists until the invitation is accepted.
 *
 * Authorization is settled before the invited email is looked up at all, so the
 * conflict outcome cannot be used by an unauthorized caller to probe who
 * belongs to an Organization.
 */
export class InviteOrganizationMember {
  constructor(
    private readonly membership: Pick<
      OrganizationMembershipPort,
      'resolveMembership'
    >,
    private readonly invitations: OrganizationInvitationPort,
    private readonly tokenIssuer: OrganizationInviteTokenPort,
    private readonly emailSender: Pick<
      EmailSenderPort,
      'sendOrganizationInviteEmail'
    >,
  ) {}

  async authorize(input: InviteOrganizationMemberInput): Promise<void> {
    await this.resolveCaller(input);
  }

  async invite(
    input: InviteOrganizationMemberInput,
  ): Promise<InvitedOrganizationMember> {
    await this.resolveCaller(input);

    let email: string;
    try {
      email = normalizeEmail(input.email);
    } catch (error) {
      throw invalidRequest(error);
    }

    const now = new Date();
    const issued = this.tokenIssuer.issue(now);
    const result = await this.invitations.createInvitation({
      context: input.context,
      invitationId: issued.id,
      organizationId: input.organizationId,
      email,
      role: input.role,
      invitedBy: input.userId,
      tokenHash: issued.hash,
      expiresAt: issued.expiresAt,
      now,
    });

    if (result.kind === 'member_exists') {
      throw new AppError({
        code: 'ORGANIZATION_MEMBER_EXISTS',
        message: 'Email already holds an active membership',
        retryable: false,
      });
    }

    try {
      await this.emailSender.sendOrganizationInviteEmail({
        email,
        organizationName: result.organizationName,
        role: input.role,
        token: issued.raw,
        expiresAt: issued.expiresAt,
      });
    } catch (error) {
      // The invitation stays durable. A retry supersedes this token, so the
      // caller can act on a retryable failure without an operator.
      throw new AppError({
        code: 'AUTH_EMAIL_DELIVERY_UNAVAILABLE',
        message: 'Email delivery is temporarily unavailable',
        retryable: true,
        cause: error,
      });
    }

    return {
      invitationId: issued.id,
      organizationId: input.organizationId,
      email,
      role: input.role,
      expiresAt: issued.expiresAt,
    };
  }

  private async resolveCaller(
    input: InviteOrganizationMemberInput,
  ): Promise<void> {
    const caller = await requireActiveMembership(this.membership, {
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
    });

    if (caller.organizationStatus === 'suspended') {
      throw forbidden('Organization is suspended');
    }

    if (caller.role === 'member') {
      throw forbidden('Organization membership role cannot invite');
    }

    if (caller.role === 'admin' && input.role !== 'member') {
      throw forbidden('Organization admins can only invite members');
    }
  }
}
