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

import { PUBLIC_ROUTES } from '../../../catalog/public-routes';
import { AppError } from '../../../common/errors/app-error';
import { invalidRequest } from '../../../common/errors/invalid-request';
import {
  PublicJsonWebKeySetSchema,
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

  @Get(PUBLIC_ROUTES['organizations.identityConfig.read'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.identityConfig.read'].successStatus)
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

  @Put(PUBLIC_ROUTES['organizations.identityConfig.set'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.identityConfig.set'].successStatus)
  async set(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
  ): Promise<ReadOrganizationIdentityConfigResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );
    if (hasInvalidInlineJwks(body)) {
      throw new AppError({
        code: 'IDENTITY_JWKS_INVALID',
        message: 'Public JWKS is invalid',
        retryable: false,
      });
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasInvalidInlineJwks(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.jwks_url === undefined || value.jwks_url === null) &&
    value.public_keys_jwks !== undefined &&
    value.public_keys_jwks !== null &&
    !Value.Check(PublicJsonWebKeySetSchema, value.public_keys_jwks)
  );
}
