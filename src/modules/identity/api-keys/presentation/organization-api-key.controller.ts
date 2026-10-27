import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { parseRequestBody } from '@/common/http/parse-request-body';
import {
  type CreateOrganizationApiKeyRequest,
  CreateOrganizationApiKeyRequestSchema,
  type ListOrganizationApiKeysResponse,
  type OrganizationApiKeySecretResponse,
  type RevokeOrganizationApiKeyResponse,
} from '@/contracts/organization/api-key';
import { UserAccessJwtGuard } from '@/modules/auth/presentation/user-access-jwt.guard';
import {
  CREATE_ORGANIZATION_API_KEY,
  type CreateOrganizationApiKeyPort,
} from '@/modules/identity/api-keys/application/create-organization-api-key.port';
import {
  LIST_ORGANIZATION_API_KEYS,
  type ListOrganizationApiKeysPort,
} from '@/modules/identity/api-keys/application/list-organization-api-keys.port';
import {
  REVOKE_ORGANIZATION_API_KEY,
  type RevokeOrganizationApiKeyPort,
} from '@/modules/identity/api-keys/application/revoke-organization-api-key.port';
import {
  ROTATE_ORGANIZATION_API_KEY,
  type RotateOrganizationApiKeyPort,
} from '@/modules/identity/api-keys/application/rotate-organization-api-key.port';

import { bearerRequestContext } from '@/modules/identity/shared/presentation/bearer-request-context';
import { OrganizationIdPipe } from '@/modules/identity/shared/presentation/organization-id.pipe';
import {
  apiKeyResponse,
  mintedApiKeyResponse,
} from './organization-api-key.response';

@Controller()
@UseGuards(UserAccessJwtGuard)
export class OrganizationApiKeyController {
  constructor(
    @Inject(CREATE_ORGANIZATION_API_KEY)
    private readonly apiKeys: CreateOrganizationApiKeyPort,
    @Inject(LIST_ORGANIZATION_API_KEYS)
    private readonly keyList: ListOrganizationApiKeysPort,
    @Inject(ROTATE_ORGANIZATION_API_KEY)
    private readonly rotation: RotateOrganizationApiKeyPort,
    @Inject(REVOKE_ORGANIZATION_API_KEY)
    private readonly revocation: RevokeOrganizationApiKeyPort,
  ) {}

  // `DELETE`, following the route that disables a member: a withdrawal that
  // keeps the durable row rather than erasing it.
  @Delete(PUBLIC_ROUTES['organizations.apiKeys.revoke'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.apiKeys.revoke'].successStatus)
  async revoke(
    @Req() request: FastifyRequest,
    @Param('organizationId', new OrganizationIdPipe()) organizationId: string,
    @Param('apiKeyId') apiKeyId: string,
  ): Promise<RevokeOrganizationApiKeyResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );

    const key = await this.revocation.revoke({
      context,
      userId,
      organizationId,
      apiKeyId,
    });

    return {
      data: apiKeyResponse(key),
      meta: { request_id: requestId },
    };
  }

  // A verb sub-resource, following the membership transfer route: rotation is
  // one act on one key, not a partial update of it.
  @Post(PUBLIC_ROUTES['organizations.apiKeys.rotate'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.apiKeys.rotate'].successStatus)
  @Header('Cache-Control', 'no-store')
  async rotate(
    @Req() request: FastifyRequest,
    @Param('organizationId', new OrganizationIdPipe()) organizationId: string,
    @Param('apiKeyId') apiKeyId: string,
  ): Promise<OrganizationApiKeySecretResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );

    const rotated = await this.rotation.rotate({
      context,
      userId,
      organizationId,
      apiKeyId,
    });

    return {
      data: mintedApiKeyResponse(rotated),
      meta: { request_id: requestId },
    };
  }

  @Get(PUBLIC_ROUTES['organizations.apiKeys.list'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.apiKeys.list'].successStatus)
  // No `Cache-Control` here, unlike creation: this response carries no
  // credential, and reserving `no-store` for the ones that do keeps it
  // meaningful.
  async list(
    @Req() request: FastifyRequest,
    @Param('organizationId', new OrganizationIdPipe()) organizationId: string,
  ): Promise<ListOrganizationApiKeysResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );

    const keys = await this.keyList.list({ context, userId, organizationId });

    return {
      data: {
        api_keys: keys.map(apiKeyResponse),
      },
      meta: { request_id: requestId },
    };
  }

  @Post(PUBLIC_ROUTES['organizations.apiKeys.create'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.apiKeys.create'].successStatus)
  // The body carries a credential that is disclosed exactly once; no cache on
  // the way to the caller may keep a copy of it.
  @Header('Cache-Control', 'no-store')
  async create(
    @Req() request: FastifyRequest,
    @Param('organizationId', new OrganizationIdPipe()) organizationId: string,
    @Body() body: unknown,
  ): Promise<OrganizationApiKeySecretResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );

    const requested: CreateOrganizationApiKeyRequest = parseRequestBody(
      CreateOrganizationApiKeyRequestSchema,
      body,
      request,
    );

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
      data: mintedApiKeyResponse(created),
      meta: { request_id: requestId },
    };
  }
}
