import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { parseRequestBody } from '@/common/http/parse-request-body';
import { isRequestId } from '@/common/request-context/request-id';
import {
  type SandboxDemoKeyValidationRequest,
  SandboxDemoKeyValidationRequestSchema,
  type SandboxDemoKeyValidationResponse,
} from '@/contracts/sandbox/demo-key-validation';
import { RateLimitGuard } from '@/modules/gateway/presentation/rate-limit.guard';
import { forbidden } from '@/modules/identity/api-keys/presentation/authenticate-api-key';
import { SandboxDemoKeyValidationGuard } from '@/modules/identity/api-keys/presentation/sandbox-demo-key-validation.guard';
import {
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfig,
  type OrganizationIdentityConfigRepositoryPort,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { identityProviderUnavailable } from '@/modules/identity/user-assertions/application/user-identity-errors';

interface ValidationEnvelope {
  readonly data: SandboxDemoKeyValidationResponse;
  readonly meta: { readonly request_id: string };
}

@Controller()
@UseGuards(SandboxDemoKeyValidationGuard, RateLimitGuard)
export class SandboxDemoKeyValidationController {
  constructor(
    @Inject(ORGANIZATION_IDENTITY_CONFIG_REPOSITORY)
    private readonly identityConfig: Pick<
      OrganizationIdentityConfigRepositoryPort,
      'findActiveByOrganizationId'
    >,
  ) {}

  @Post(PUBLIC_ROUTES['sandbox.demo-key.validate'].path)
  @HttpCode(PUBLIC_ROUTES['sandbox.demo-key.validate'].successStatus)
  async validate(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ValidationEnvelope> {
    const input: SandboxDemoKeyValidationRequest = parseRequestBody(
      SandboxDemoKeyValidationRequestSchema,
      body,
    );
    const authenticated = getAuthenticatedApiKey(request);
    if (!authenticated.scopes.includes(input.scope)) throw forbidden();

    let configuredIdentity: OrganizationIdentityConfig | null;
    try {
      configuredIdentity = await this.identityConfig.findActiveByOrganizationId(
        authenticated.organizationId,
      );
    } catch (error) {
      throw identityProviderUnavailable(error);
    }
    if (configuredIdentity !== null) throw forbidden();

    return {
      data: {
        valid: true,
        environment: 'sandbox',
        scope: input.scope,
      },
      meta: {
        request_id: isRequestId(request.id) ? request.id : String(request.id),
      },
    };
  }
}
