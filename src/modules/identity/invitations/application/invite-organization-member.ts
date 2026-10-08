import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import type { IdMinter } from '@/common/ids/prefixed-id';
import type { RequestContext } from '@/common/request-context/request-context';
import { type AuthRateLimiterPort } from '@/modules/auth/application/auth-rate-limiter.port';
import { normalizeEmail } from '@/modules/auth/public/local-auth';

import {
  forbidden,
  requireOrganizationManager,
} from '@/modules/identity/membership/application/organization-membership.authorization';
import type {
  OrganizationMembershipPort,
  OrganizationMembershipRole,
} from '@/modules/identity/membership/application/organization-membership.port';
import type { OrganizationInvitationPort } from './organization-invitation.port';
import type { OrganizationInviteTokenPort } from './organization-invite-token.port';

const INVITATION_SENDING_FORBIDDEN =
  'Organization invitation sending is forbidden';

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
  /** Acceptance-time only: the request is queued, not yet with the provider. */
  readonly emailDeliveryStatus: 'queued';
}

export const ORGANIZATION_INVITATION_RATE_LIMITS = {
  user: {
    scope: 'organization_invitation_user',
    limit: 5,
    windowMs: 15 * 60 * 1000,
  },
  organization: {
    scope: 'organization_invitation_organization',
    limit: 20,
    windowMs: 15 * 60 * 1000,
  },
  email: {
    scope: 'organization_invitation_email',
    limit: 3,
    windowMs: 24 * 60 * 60 * 1000,
  },
} as const;

function rateLimited(retryAfterMs: number | undefined): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Too many requests',
    retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
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
    private readonly rateLimiter: AuthRateLimiterPort,
    private readonly newEmailDeliveryId: IdMinter,
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

    await this.enforceRateLimits(input, email);

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
      // The request that carries the credential is committed with the
      // invitation, so a caller retrying after a delivery failure re-sends
      // nothing: a worker dispatches the row (ADR-0074).
      emailDelivery: {
        id: this.newEmailDeliveryId(now),
        token: issued.raw,
        createdAt: now,
      },
      now,
    });

    if (result.kind === 'member_exists') {
      throw new AppError({
        code: 'ORGANIZATION_MEMBER_EXISTS',
        message: 'Email already holds an active membership',
        retryable: false,
      });
    }

    return {
      invitationId: issued.id,
      organizationId: input.organizationId,
      email,
      role: input.role,
      expiresAt: issued.expiresAt,
      emailDeliveryStatus: 'queued',
    };
  }

  private async resolveCaller(
    input: InviteOrganizationMemberInput,
  ): Promise<void> {
    const caller = await requireOrganizationManager(
      this.membership,
      {
        context: input.context,
        userId: input.userId,
        organizationId: input.organizationId,
      },
      INVITATION_SENDING_FORBIDDEN,
    );

    // An admin has proved authority to invite, so the limit on what they may
    // grant is a reason about the request and keeps its own message.
    if (caller.role === 'admin' && input.role !== 'member') {
      throw forbidden('Organization admins can only invite members');
    }
  }

  private async enforceRateLimits(
    input: InviteOrganizationMemberInput,
    email: string,
  ): Promise<void> {
    const requests = [
      { ...ORGANIZATION_INVITATION_RATE_LIMITS.user, key: input.userId },
      {
        ...ORGANIZATION_INVITATION_RATE_LIMITS.organization,
        key: input.organizationId,
      },
      { ...ORGANIZATION_INVITATION_RATE_LIMITS.email, key: email },
    ];

    for (const request of requests) {
      const decision = await this.rateLimiter.consume(request);
      if (!decision.allowed) {
        throw rateLimited(decision.retryAfterMs);
      }
    }
  }
}
