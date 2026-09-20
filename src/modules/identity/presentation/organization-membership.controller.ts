import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AppError } from '../../../common/errors/app-error';
import { isRequestId } from '../../../common/request-context/request-id';
import type { OrganizationRosterResponse } from '../../../contracts/organization/membership';
import { UserAccessJwtGuard } from '../../auth/presentation/user-access-jwt.guard';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
} from '../application/organization-membership.port';

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
    const userId = request.aihubUser?.userId;
    if (userId === undefined) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Authenticated user context is missing',
        retryable: false,
      });
    }

    const organizations = await this.membership.listRoster(userId);
    const requestId = isRequestId(request.id) ? request.id : String(request.id);

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
