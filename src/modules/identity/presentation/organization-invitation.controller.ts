import {
  Body,
  Controller,
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
  type CreateOrganizationInvitationRequest,
  CreateOrganizationInvitationRequestSchema,
  type CreateOrganizationInvitationResponse,
} from '../../../contracts/organization/invitation';
import { UserAccessJwtGuard } from '../../auth/presentation/user-access-jwt.guard';
import {
  INVITE_ORGANIZATION_MEMBER,
  type InviteOrganizationMemberPort,
} from '../application/invite-organization-member.port';

import { bearerRequestContext } from './bearer-request-context';

@Controller()
@UseGuards(UserAccessJwtGuard)
export class OrganizationInvitationController {
  constructor(
    @Inject(INVITE_ORGANIZATION_MEMBER)
    private readonly inviteMember: InviteOrganizationMemberPort,
  ) {}

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
}
