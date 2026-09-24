import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import type { FastifyRequest } from 'fastify';

import { invalidRequest } from '../../../common/errors/invalid-request';
import {
  EmptyOrganizationMembershipMutationRequestSchema,
  ORGANIZATION_MEMBERSHIP_LIST_PATH,
  ORGANIZATION_ROSTER_PATH,
  type OrganizationMembershipListQuery,
  OrganizationMembershipListQuerySchema,
  type OrganizationMembershipListResponse,
  type OrganizationMembershipMutationRequest,
  OrganizationMembershipMutationRequestSchema,
  type OrganizationMembershipMutationResponse,
  type OrganizationRosterResponse,
} from '../../../contracts/organization/membership';
import { UserAccessJwtGuard } from '../../auth/presentation/user-access-jwt.guard';
import { ListOrganizationMemberships } from '../application/list-organization-memberships';
import {
  ORGANIZATION_MEMBERSHIP_MUTATION,
  type OrganizationMembershipMutationPort,
} from '../application/organization-membership-mutation.port';
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
    @Inject(ORGANIZATION_MEMBERSHIP_MUTATION)
    private readonly mutation: OrganizationMembershipMutationPort,
    private readonly membershipList: ListOrganizationMemberships,
  ) {}

  @Get(ORGANIZATION_MEMBERSHIP_LIST_PATH)
  @HttpCode(200)
  async listOrganizationMembers(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
  ): Promise<OrganizationMembershipListResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );
    const rawQuery: unknown = request.query;
    if (!Value.Check(OrganizationMembershipListQuerySchema, rawQuery)) {
      throw invalidRequest();
    }

    const query: OrganizationMembershipListQuery = rawQuery;
    const members = await this.membershipList.list({
      context,
      userId,
      organizationId,
      status: query.status ?? 'active',
    });

    return {
      data: {
        members: members.map((member) => ({
          username: member.username,
          role: member.role,
          status: member.status,
        })),
      },
      meta: { request_id: requestId },
    };
  }

  @Get(ORGANIZATION_ROSTER_PATH)
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
          entitlements: [...organization.entitlements],
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

  @Patch('/v1/organizations/:organizationId/members/:username')
  @HttpCode(200)
  async changeRole(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
    @Param('username') username: string,
    @Body() body: unknown,
  ): Promise<OrganizationMembershipMutationResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );

    if (!Value.Check(OrganizationMembershipMutationRequestSchema, body)) {
      throw invalidRequest();
    }
    const mutation: OrganizationMembershipMutationRequest = body;
    const result = await this.mutation.changeRole({
      context,
      userId,
      organizationId,
      username,
      role: mutation.role,
    });

    return mutationResponse(result, requestId);
  }

  @Delete('/v1/organizations/:organizationId/members/:username')
  @HttpCode(200)
  async disable(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
    @Param('username') username: string,
    @Body() body: unknown,
  ): Promise<OrganizationMembershipMutationResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );
    assertEmptyBody(body);

    const result = await this.mutation.disable({
      context,
      userId,
      organizationId,
      username,
    });

    return mutationResponse(result, requestId);
  }

  @Post('/v1/organizations/:organizationId/members/:username/transfer')
  @HttpCode(200)
  async transfer(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
    @Param('username') username: string,
    @Body() body: unknown,
  ): Promise<OrganizationMembershipMutationResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );
    assertEmptyBody(body);

    const result = await this.mutation.transfer({
      context,
      userId,
      organizationId,
      username,
    });

    return mutationResponse(result, requestId);
  }
}

function assertEmptyBody(body: unknown): void {
  if (
    !Value.Check(
      EmptyOrganizationMembershipMutationRequestSchema,
      body === undefined ? {} : body,
    )
  ) {
    throw invalidRequest();
  }
}

function mutationResponse(
  result: Awaited<ReturnType<OrganizationMembershipMutationPort['disable']>>,
  requestId: string,
): OrganizationMembershipMutationResponse {
  return {
    data: {
      organization_id: result.organizationId,
      username: result.username,
      role: result.role,
      status: result.status,
    },
    meta: { request_id: requestId },
  };
}
