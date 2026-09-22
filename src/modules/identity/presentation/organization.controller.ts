import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { invalidRequest } from '../../../common/errors/invalid-request';
import {
  type CreateOrganizationRequest,
  CreateOrganizationRequestSchema,
  type CreateOrganizationResponse,
} from '../../../contracts/organization/organization';
import { UserAccessJwtGuard } from '../../auth/presentation/user-access-jwt.guard';
import { ORGANIZATION_CREATE_OPERATION } from '../../idempotency/application/idempotency-operation';
import {
  IDEMPOTENCY_SERVICE,
  type IdempotencyServicePort,
} from '../../idempotency/application/idempotency-service.port';
import { resolveIdempotencyKey } from '../../idempotency/presentation/idempotency-key';
import type { CreatedOrganization } from '../application/create-organization';
import {
  CREATE_ORGANIZATION,
  type CreateOrganizationPort,
} from '../application/create-organization.port';

import { bearerRequestContext } from './bearer-request-context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeOrganizationReplay(value: unknown): CreatedOrganization {
  if (!isRecord(value)) {
    throw new Error('stored organization replay is invalid');
  }
  const { organizationId, name, status, role } = value;
  if (
    typeof organizationId !== 'string' ||
    typeof name !== 'string' ||
    status !== 'active' ||
    role !== 'owner'
  ) {
    throw new Error('stored organization replay is invalid');
  }
  return { organizationId, name, status, role };
}

@Controller()
@UseGuards(UserAccessJwtGuard)
export class OrganizationController {
  constructor(
    @Inject(CREATE_ORGANIZATION)
    private readonly createOrganization: CreateOrganizationPort,
    @Inject(IDEMPOTENCY_SERVICE)
    private readonly idempotency: IdempotencyServicePort,
  ) {}

  @Post('/v1/organizations')
  @HttpCode(201)
  async create(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CreateOrganizationResponse> {
    const { context, requestId, userId } = bearerRequestContext(request);

    if (!Value.Check(CreateOrganizationRequestSchema, body)) {
      throw invalidRequest();
    }
    const requested: CreateOrganizationRequest = body;
    const name = requested.name.trim();

    const idempotencyKey = resolveIdempotencyKey(
      ORGANIZATION_CREATE_OPERATION,
      request.headers['idempotency-key'],
    );
    // An Account Idempotency Scope: no Organization exists to scope it to.
    const execution = await this.idempotency.execute(
      {
        organizationId: null,
        operation: ORGANIZATION_CREATE_OPERATION,
        scope: 'management',
        actorId: userId,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        requestBody: { name },
        requestId,
        timeoutMs: 5_000,
        responseStatus: 201,
        signal: context.signal,
        deadlineAt: context.deadlineAt,
      },
      (workContext) =>
        this.createOrganization.create({
          context: {
            ...context,
            signal: workContext.signal,
            deadlineAt: workContext.deadlineAt,
          },
          userId,
          name,
        }),
      decodeOrganizationReplay,
    );

    if (execution.replay) {
      reply.header('Idempotent-Replay', 'true');
    }

    const created = execution.result;
    return {
      data: {
        organization: {
          organization_id: created.organizationId,
          name: created.name,
          status: created.status,
        },
        role: created.role,
      },
      meta: { request_id: requestId },
    };
  }
}
