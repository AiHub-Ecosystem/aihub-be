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
import { Value } from '@sinclair/typebox/value';
import type { FastifyRequest } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { invalidRequest } from '@/common/errors/invalid-request';
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

import { bearerRequestContext } from '@/modules/identity/presentation/bearer-request-context';

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
    @Param('organizationId') organizationId: string,
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
      data: {
        id: key.id,
        name: key.name,
        key_prefix: key.keyPrefix,
        scopes: [...key.scopes],
        allowed_environments: [...key.allowedEnvironments],
        status: key.status,
        expires_at: key.expiresAt?.toISOString() ?? null,
        last_used_at: key.lastUsedAt?.toISOString() ?? null,
        created_at: key.createdAt.toISOString(),
      },
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
    @Param('organizationId') organizationId: string,
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
      data: {
        api_key: rotated.apiKey,
        id: rotated.id,
        name: rotated.name,
        key_prefix: rotated.keyPrefix,
        scopes: [...rotated.scopes],
        allowed_environments: [...rotated.allowedEnvironments],
        status: 'active',
        expires_at: rotated.expiresAt?.toISOString() ?? null,
        last_used_at: null,
        created_at: rotated.createdAt.toISOString(),
      },
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
    @Param('organizationId') organizationId: string,
  ): Promise<ListOrganizationApiKeysResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );

    const keys = await this.keyList.list({ context, userId, organizationId });

    return {
      data: {
        api_keys: keys.map((key) => ({
          id: key.id,
          name: key.name,
          key_prefix: key.keyPrefix,
          scopes: [...key.scopes],
          allowed_environments: [...key.allowedEnvironments],
          status: key.status,
          expires_at: key.expiresAt?.toISOString() ?? null,
          last_used_at: key.lastUsedAt?.toISOString() ?? null,
          created_at: key.createdAt.toISOString(),
        })),
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
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
  ): Promise<OrganizationApiKeySecretResponse> {
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
