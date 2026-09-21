import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { OrganizationRosterResponse } from '../../../contracts/organization/membership';
import { UserAccessJwtGuard } from '../../auth/presentation/user-access-jwt.guard';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
} from '../application/organization-membership.port';

import { bearerRequestContext } from './bearer-request-context';

@Controller()
@UseGuards(UserAccessJwtGuard)
export class OrganizationMembershipController {
  constructor(
    @Inject(ORGANIZATION_MEMBERSHIP)
    private readonly membership: OrganizationMembershipPort,
  ) {}

  @Get('/v1/organizations/me/members')
  @HttpCode(200)
  async roster(
    @Req() request: FastifyRequest,
  ): Promise<OrganizationRosterResponse> {
    const { context, requestId, userId } = bearerRequestContext(request);
    const organizations = await this.membership.listRoster({ context, userId });

    return {
      data: {
        organizations: organizations.map((organization) => ({
          organization_id: organization.organizationId,
          name: organization.name,
          status: organization.status,
          membership: { role: organization.membershipRole },
          members: organization.members.map((member) => ({
            username: member.username,
            role: member.role,
          })),
        })),
      },
      meta: { request_id: requestId },
    };
  }
}
