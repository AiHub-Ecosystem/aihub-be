import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { ReadOrganizationIdentityConfigResponse } from '../../../contracts/organization/identity-config';
import { UserAccessJwtGuard } from '../../auth/presentation/user-access-jwt.guard';
import {
  READ_ORGANIZATION_IDENTITY_CONFIG,
  type ReadOrganizationIdentityConfigPort,
} from '../application/read-organization-identity-config.port';

import { bearerRequestContext } from './bearer-request-context';

@Controller()
@UseGuards(UserAccessJwtGuard)
export class OrganizationIdentityConfigController {
  constructor(
    @Inject(READ_ORGANIZATION_IDENTITY_CONFIG)
    private readonly identityConfigs: ReadOrganizationIdentityConfigPort,
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
      data: {
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
      },
      meta: { request_id: requestId },
    };
  }
}
