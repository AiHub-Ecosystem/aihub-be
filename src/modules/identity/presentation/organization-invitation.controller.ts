import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import type { FastifyRequest } from 'fastify';

import { invalidRequest } from '../../../common/errors/invalid-request';
import {
  type AcceptOrganizationInvitationRequest,
  AcceptOrganizationInvitationRequestSchema,
  type AcceptOrganizationInvitationResponse,
  type CreateOrganizationInvitationRequest,
  CreateOrganizationInvitationRequestSchema,
  type CreateOrganizationInvitationResponse,
  type ListOpenOrganizationInvitationsResponse,
} from '../../../contracts/organization/invitation';
import { UserAccessJwtGuard } from '../../auth/presentation/user-access-jwt.guard';
import {
  ACCEPT_ORGANIZATION_INVITATION,
  type AcceptOrganizationInvitationPort,
} from '../application/accept-organization-invitation.port';
import {
  INVITE_ORGANIZATION_MEMBER,
  type InviteOrganizationMemberPort,
} from '../application/invite-organization-member.port';
import {
  LIST_OPEN_ORGANIZATION_INVITATIONS,
  type ListOpenOrganizationInvitationsPort,
} from '../application/list-open-organization-invitations.port';
import {
  REVOKE_ORGANIZATION_INVITATION,
  type RevokeOrganizationInvitationPort,
} from '../application/revoke-organization-invitation.port';

import { bearerRequestContext } from './bearer-request-context';

@Controller()
@UseGuards(UserAccessJwtGuard)
export class OrganizationInvitationController {
  constructor(
    @Inject(INVITE_ORGANIZATION_MEMBER)
    private readonly inviteMember: InviteOrganizationMemberPort,
    @Inject(ACCEPT_ORGANIZATION_INVITATION)
    private readonly acceptInvitation: AcceptOrganizationInvitationPort,
    @Inject(LIST_OPEN_ORGANIZATION_INVITATIONS)
    private readonly listOpenInvitations: ListOpenOrganizationInvitationsPort,
    @Inject(REVOKE_ORGANIZATION_INVITATION)
    private readonly revokeInvitation: RevokeOrganizationInvitationPort,
  ) {}

  // The router ranks this static path above the parameterised invite route, so
  // an organization that happens to be called "invitations" still resolves.
  @Post('/v1/organizations/invitations/accept')
  @HttpCode(200)
  async accept(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AcceptOrganizationInvitationResponse> {
    const { context, requestId, userId } = bearerRequestContext(request);

    if (!Value.Check(AcceptOrganizationInvitationRequestSchema, body)) {
      throw invalidRequest();
    }
    const accepted: AcceptOrganizationInvitationRequest = body;

    const membership = await this.acceptInvitation.accept({
      context,
      userId,
      token: accepted.token,
    });

    return {
      data: {
        organization_id: membership.organizationId,
        role: membership.role,
        status: 'active',
      },
      meta: { request_id: requestId },
    };
  }

  @Post('/v1/organizations/:organizationId/invitations')
  @HttpCode(201)
  async invite(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
  ): Promise<CreateOrganizationInvitationResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );

    if (!Value.Check(CreateOrganizationInvitationRequestSchema, body)) {
      throw invalidRequest();
    }
    const invitation: CreateOrganizationInvitationRequest = body;

    const created = await this.inviteMember.invite({
      context,
      userId,
      organizationId,
      email: invitation.email,
      role: invitation.role,
    });

    return {
      data: {
        invitation_id: created.invitationId,
        organization_id: created.organizationId,
        email: created.email,
        role: created.role,
        status: 'pending',
        expires_at: created.expiresAt.toISOString(),
      },
      meta: { request_id: requestId },
    };
  }

  @Get('/v1/organizations/:organizationId/invitations')
  @HttpCode(200)
  async list(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
  ): Promise<ListOpenOrganizationInvitationsResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );
    const invitations = await this.listOpenInvitations.list({
      context,
      userId,
      organizationId,
      now: context.receivedAt,
    });

    return {
      data: {
        invitations: invitations.map((invitation) => ({
          invitation_id: invitation.invitationId,
          email: invitation.email,
          role: invitation.role,
          invited_by_username: invitation.invitedByUsername,
          created_at: invitation.createdAt.toISOString(),
          expires_at: invitation.expiresAt.toISOString(),
          status: invitation.status,
        })),
      },
      meta: { request_id: requestId },
    };
  }

  @Delete('/v1/organizations/:organizationId/invitations/:invitationId')
  @HttpCode(204)
  async revoke(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
    @Param('invitationId') invitationId: string,
  ): Promise<void> {
    const { context, userId } = bearerRequestContext(request, organizationId);

    await this.revokeInvitation.revoke({
      context,
      userId,
      organizationId,
      invitationId,
    });
  }
}
