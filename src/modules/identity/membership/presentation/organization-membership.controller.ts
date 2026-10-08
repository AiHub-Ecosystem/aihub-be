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

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { invalidRequest } from '@/common/errors/invalid-request';
import { parseRequestBody } from '@/common/http/parse-request-body';
import {
  EmptyOrganizationMembershipMutationRequestSchema,
  type OrganizationMembershipListQuery,
  OrganizationMembershipListQuerySchema,
  type OrganizationMembershipListResponse,
  type OrganizationMembershipMutationRequest,
  OrganizationMembershipMutationRequestSchema,
  type OrganizationMembershipMutationResponse,
  type OrganizationRosterResponse,
} from '@/contracts/organization/membership';
import { UserAccessJwtGuard } from '@/modules/auth/presentation/user-access-jwt.guard';
import { ListOrganizationMemberships } from '@/modules/identity/membership/application/list-organization-memberships';
import {
  ORGANIZATION_MEMBERSHIP_MUTATION,
  type OrganizationMembershipMutationPort,
} from '@/modules/identity/membership/application/organization-membership-mutation.port';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
} from '@/modules/identity/membership/application/organization-membership.port';

import { bearerRequestContext } from '@/modules/identity/shared/presentation/bearer-request-context';

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

  @Get(PUBLIC_ROUTES['organizations.members.list'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.members.list'].successStatus)
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
      // arch-check: validates a query, not a body
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

  @Get(PUBLIC_ROUTES['organizations.me.members.list'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.me.members.list'].successStatus)
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
          identity_configured: organization.identityConfigured,
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

  @Patch(PUBLIC_ROUTES['organizations.members.change_role'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.members.change_role'].successStatus)
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

    const mutation: OrganizationMembershipMutationRequest = parseRequestBody(
      OrganizationMembershipMutationRequestSchema,
      body,
    );
    const result = await this.mutation.changeRole({
      context,
      userId,
      organizationId,
      username,
      role: mutation.role,
    });

    return mutationResponse(result, requestId);
  }

  @Delete(PUBLIC_ROUTES['organizations.members.disable'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.members.disable'].successStatus)
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
    parseRequestBody(EmptyOrganizationMembershipMutationRequestSchema, body);

    const result = await this.mutation.disable({
      context,
      userId,
      organizationId,
      username,
    });

    return mutationResponse(result, requestId);
  }

  @Post(PUBLIC_ROUTES['organizations.members.transfer'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.members.transfer'].successStatus)
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
    parseRequestBody(EmptyOrganizationMembershipMutationRequestSchema, body);

    const result = await this.mutation.transfer({
      context,
      userId,
      organizationId,
      username,
    });

    return mutationResponse(result, requestId);
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
