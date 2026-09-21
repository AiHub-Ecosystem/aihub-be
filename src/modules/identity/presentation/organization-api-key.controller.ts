import {
  Body,
  Controller,
  Header,
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
  type CreateOrganizationApiKeyRequest,
  CreateOrganizationApiKeyRequestSchema,
  type CreateOrganizationApiKeyResponse,
} from '../../../contracts/organization/api-key';
import { UserAccessJwtGuard } from '../../auth/presentation/user-access-jwt.guard';
import {
  CREATE_ORGANIZATION_API_KEY,
  type CreateOrganizationApiKeyPort,
} from '../application/create-organization-api-key.port';

import { bearerRequestContext } from './bearer-request-context';

@Controller()
@UseGuards(UserAccessJwtGuard)
export class OrganizationApiKeyController {
  constructor(
    @Inject(CREATE_ORGANIZATION_API_KEY)
    private readonly apiKeys: CreateOrganizationApiKeyPort,
  ) {}

  @Post('/v1/organizations/:organizationId/api-keys')
  @HttpCode(201)
  // The body carries a credential that is disclosed exactly once; no cache on
  // the way to the caller may keep a copy of it.
  @Header('Cache-Control', 'no-store')
  async create(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
  ): Promise<CreateOrganizationApiKeyResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );

    if (!Value.Check(CreateOrganizationApiKeyRequestSchema, body)) {
      throw invalidRequest();
    }
    const requested: CreateOrganizationApiKeyRequest = body;

    const created = await this.apiKeys.create({
      context,
      userId,
      organizationId,
      name: requested.name,
      scopes: requested.scopes,
      ...(requested.allowed_environments === undefined
        ? {}
        : { allowedEnvironments: requested.allowed_environments }),
      ...(requested.expires_at === undefined
        ? {}
        : { expiresAt: requested.expires_at }),
    });

    return {
      data: {
        api_key: created.apiKey,
        id: created.id,
        name: created.name,
        key_prefix: created.keyPrefix,
        scopes: [...created.scopes],
        allowed_environments: [...created.allowedEnvironments],
        status: 'active',
        expires_at: created.expiresAt?.toISOString() ?? null,
        last_used_at: null,
        created_at: created.createdAt.toISOString(),
      },
      meta: { request_id: requestId },
    };
  }
}
