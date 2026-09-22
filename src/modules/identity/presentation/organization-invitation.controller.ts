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
  Res,
  UseGuards,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import type { FastifyReply, FastifyRequest } from 'fastify';

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
import { normalizeEmail } from '../../auth/domain/local-auth';
import { UserAccessJwtGuard } from '../../auth/presentation/user-access-jwt.guard';
import { ORGANIZATION_INVITATION_CREATE_OPERATION } from '../../idempotency/application/idempotency-operation';
import {
  IDEMPOTENCY_SERVICE,
  type IdempotencyServicePort,
} from '../../idempotency/application/idempotency-service.port';
import { resolveIdempotencyKey } from '../../idempotency/presentation/idempotency-key';
import {
  ACCEPT_ORGANIZATION_INVITATION,
  type AcceptOrganizationInvitationPort,
} from '../application/accept-organization-invitation.port';
import type { InvitedOrganizationMember } from '../application/invite-organization-member';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeInvitationReplay(value: unknown): InvitedOrganizationMember {
  if (!isRecord(value)) {
    throw new Error('stored invitation replay is invalid');
  }

  const invitationId = value.invitationId;
  const organizationId = value.organizationId;
  const email = value.email;
  const role = value.role;
  const expiresAt = value.expiresAt;
  if (
    typeof invitationId !== 'string' ||
    typeof organizationId !== 'string' ||
    typeof email !== 'string' ||
    (role !== 'owner' && role !== 'admin' && role !== 'member') ||
    typeof expiresAt !== 'string'
  ) {
    throw new Error('stored invitation replay is invalid');
  }

  const parsedExpiresAt = new Date(expiresAt);
  if (Number.isNaN(parsedExpiresAt.getTime())) {
    throw new Error('stored invitation replay is invalid');
  }

  return {
    invitationId,
    organizationId,
    email,
    role,
    expiresAt: parsedExpiresAt,
  };
}

@Controller()
@UseGuards(UserAccessJwtGuard)
export class OrganizationInvitationController {
  constructor(
    @Inject(INVITE_ORGANIZATION_MEMBER)
    private readonly inviteMember: InviteOrganizationMemberPort,
    @Inject(IDEMPOTENCY_SERVICE)
    private readonly idempotency: IdempotencyServicePort,
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
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CreateOrganizationInvitationResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );

    if (!Value.Check(CreateOrganizationInvitationRequestSchema, body)) {
      throw invalidRequest();
    }
    const invitation: CreateOrganizationInvitationRequest = body;
    let email: string;
    try {
      email = normalizeEmail(invitation.email);
    } catch (error) {
      throw invalidRequest(error);
    }

    const command = {
      context,
      userId,
      organizationId,
      email,
      role: invitation.role,
    };
    await this.inviteMember.authorize(command);

    const idempotencyKey = resolveIdempotencyKey(
      ORGANIZATION_INVITATION_CREATE_OPERATION,
      request.headers['idempotency-key'],
    );
    const execution = await this.idempotency.execute(
      {
        organizationId,
        operation: ORGANIZATION_INVITATION_CREATE_OPERATION,
        scope: 'management',
        actorId: userId,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        requestBody: { email, role: invitation.role },
        requestId,
        timeoutMs: 5_000,
        responseStatus: 201,
        signal: context.signal,
        deadlineAt: context.deadlineAt,
      },
      (workContext) =>
        this.inviteMember.invite({
          ...command,
          context: {
            ...context,
            signal: workContext.signal,
            deadlineAt: workContext.deadlineAt,
          },
        }),
      decodeInvitationReplay,
    );

    if (execution.replay) {
      reply.header('Idempotent-Replay', 'true');
    }

    const created = execution.result;

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
