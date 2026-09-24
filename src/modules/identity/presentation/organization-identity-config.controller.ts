import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import type { FastifyRequest } from 'fastify';

import { invalidRequest } from '../../../common/errors/invalid-request';
import {
  type ReadOrganizationIdentityConfigResponse,
  type SetOrganizationIdentityConfigRequest,
  SetOrganizationIdentityConfigRequestSchema,
} from '../../../contracts/organization/identity-config';
import { UserAccessJwtGuard } from '../../auth/presentation/user-access-jwt.guard';
import type { StoredOrganizationIdentityConfig } from '../application/organization-identity-config-repository.port';
import {
  READ_ORGANIZATION_IDENTITY_CONFIG,
  type ReadOrganizationIdentityConfigPort,
} from '../application/read-organization-identity-config.port';
import {
  SET_ORGANIZATION_IDENTITY_CONFIG,
  type SetOrganizationIdentityConfigPort,
} from '../application/set-organization-identity-config.port';

import { bearerRequestContext } from './bearer-request-context';

type ConfiguredResponse = Extract<
  ReadOrganizationIdentityConfigResponse['data'],
  { readonly configured: true }
>;

function configuredResponse(
  config: StoredOrganizationIdentityConfig,
): ConfiguredResponse {
  return {
    configured: true,
    issuer: config.issuer,
    jwks_url: config.jwksUrl,
    public_keys_jwks:
      config.publicKeysJwks === null
        ? null
        : { keys: config.publicKeysJwks.keys.map((key) => ({ ...key })) },
    allowed_algorithms: [...config.allowedAlgorithms],
    max_assertion_ttl_seconds: config.maxAssertionTtlSeconds,
    status: config.status,
    updated_at: config.updatedAt.toISOString(),
  };
}

@Controller()
@UseGuards(UserAccessJwtGuard)
export class OrganizationIdentityConfigController {
  constructor(
    @Inject(READ_ORGANIZATION_IDENTITY_CONFIG)
    private readonly identityConfigs: ReadOrganizationIdentityConfigPort,
    @Inject(SET_ORGANIZATION_IDENTITY_CONFIG)
    private readonly setIdentityConfig: SetOrganizationIdentityConfigPort,
  ) {}

  @Get('/v1/organizations/:organizationId/identity-config')
  @HttpCode(200)
  async read(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
  ): Promise<ReadOrganizationIdentityConfigResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );
    const result = await this.identityConfigs.read({
      context,
      userId,
      organizationId,
    });

    if (!result.configured) {
      return {
        data: { configured: false },
        meta: { request_id: requestId },
      };
    }

    const config = result.config;
    return {
      data: configuredResponse(config),
      meta: { request_id: requestId },
    };
  }

  @Put('/v1/organizations/:organizationId/identity-config')
  @HttpCode(200)
  async set(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
  ): Promise<ReadOrganizationIdentityConfigResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );
    if (!Value.Check(SetOrganizationIdentityConfigRequestSchema, body)) {
      throw invalidRequest();
    }
    const requested: SetOrganizationIdentityConfigRequest = body;
    const config = await this.setIdentityConfig.set({
      context,
      userId,
      organizationId,
      issuer: requested.issuer,
      jwksUrl: requested.jwks_url ?? null,
      publicKeysJwks: requested.public_keys_jwks ?? null,
      ...(requested.allowed_algorithms === undefined
        ? {}
        : { allowedAlgorithms: requested.allowed_algorithms }),
      ...(requested.max_assertion_ttl_seconds === undefined
        ? {}
        : { maxAssertionTtlSeconds: requested.max_assertion_ttl_seconds }),
    });

    return {
      data: configuredResponse(config),
      meta: { request_id: requestId },
    };
  }
}
