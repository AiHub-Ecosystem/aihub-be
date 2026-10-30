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
import type { FastifyRequest } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { parseRequestBody } from '@/common/http/parse-request-body';
import { parseRequestQuery } from '@/common/http/parse-request-query';
import {
  EmptyOrganizationMembershipMutationRequestSchema,
  OrganizationMembershipListQuerySchema,
  type OrganizationMembershipListResponse,
  type OrganizationMembershipMutationRequest,
  OrganizationMembershipMutationRequestSchema,
  type OrganizationMembershipMutationResponse,
  OrganizationRosterQuerySchema,
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
import { encodeCursor } from '@/modules/identity/shared/presentation/cursor-codec';
import { OrganizationIdPipe } from '@/modules/identity/shared/presentation/organization-id.pipe';
import { parseOrganizationMembershipQuery } from './organization-membership-query';
import {
  parseOrganizationRosterQuery,
  rosterCursorScope,
} from './organization-roster-query';

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
    @Param('organizationId', new OrganizationIdPipe()) organizationId: string,
  ): Promise<OrganizationMembershipListResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );
    const query = parseRequestQuery(
      OrganizationMembershipListQuerySchema,
      request.query,
    );
    const { status, after, limit } = parseOrganizationMembershipQuery(
      query,
      organizationId,
    );
    const page = await this.membershipList.list({
      context,
      userId,
      organizationId,
      status,
      ...(after === undefined ? {} : { after }),
      limit,
    });

    return {
      data: {
        members: page.members.map((member) => ({
          username: member.username,
          role: member.role,
          status: member.status,
        })),
        next_cursor:
          page.next === undefined
            ? null
            : encodeCursor({ username: page.next }, { organizationId, status }),
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
    const query = parseRequestQuery(
      OrganizationRosterQuerySchema,
      request.query,
    );
    const { after, limit } = parseOrganizationRosterQuery(query, userId);
    const page = await this.membership.listRoster({
      context,
      userId,
      limit,
      ...(after === undefined ? {} : { after }),
    });

    return {
      data: {
        organizations: page.organizations.map((organization) => ({
          organization_id: organization.organizationId,
          name: organization.name,
          status: organization.status,
          identity_configured: organization.identityConfigured,
          entitlements: [...organization.entitlements],
          membership: { role: organization.membershipRole },
          member_count: organization.memberCount,
          members: organization.members.map((member) => ({
            username: member.username,
            role: member.role,
          })),
        })),
        next_cursor:
          page.next === undefined
            ? null
            : encodeCursor(
                { organizationId: page.next },
                rosterCursorScope(userId),
              ),
      },
      meta: { request_id: requestId },
    };
  }

  @Patch(PUBLIC_ROUTES['organizations.members.change_role'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.members.change_role'].successStatus)
  async changeRole(
    @Req() request: FastifyRequest,
    @Param('organizationId', new OrganizationIdPipe()) organizationId: string,
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
      request,
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
    @Param('organizationId', new OrganizationIdPipe()) organizationId: string,
    @Param('username') username: string,
    @Body() body: unknown,
  ): Promise<OrganizationMembershipMutationResponse> {
    return this.emptyBodyMutation(
      'disable',
      request,
      organizationId,
      username,
      body,
    );
  }

  @Post(PUBLIC_ROUTES['organizations.members.transfer'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.members.transfer'].successStatus)
  async transfer(
    @Req() request: FastifyRequest,
    @Param('organizationId', new OrganizationIdPipe()) organizationId: string,
    @Param('username') username: string,
    @Body() body: unknown,
  ): Promise<OrganizationMembershipMutationResponse> {
    return this.emptyBodyMutation(
      'transfer',
      request,
      organizationId,
      username,
      body,
    );
  }

  // Disable and transfer take no body: the same Bearer context, an empty-body
  // check, and one mutation call.
  private async emptyBodyMutation(
    action: 'disable' | 'transfer',
    request: FastifyRequest,
    organizationId: string,
    username: string,
    body: unknown,
  ): Promise<OrganizationMembershipMutationResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );
    parseRequestBody(
      EmptyOrganizationMembershipMutationRequestSchema,
      body,
      request,
    );

    const result = await this.mutation[action]({
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
