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
import { SandboxDemoKeyValidationGuard } from '@/modules/identity/api-keys/presentation/sandbox-demo-key-validation.guard';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { ValidateSandboxDemoKey } from '@/modules/identity/user-assertions/application/validate-sandbox-demo-key';

interface ValidationEnvelope {
  readonly data: SandboxDemoKeyValidationResponse;
  readonly meta: { readonly request_id: string };
}

@Controller()
@UseGuards(SandboxDemoKeyValidationGuard, RateLimitGuard)
export class SandboxDemoKeyValidationController {
  constructor(
    @Inject(ValidateSandboxDemoKey)
    private readonly validator: ValidateSandboxDemoKey,
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

    await this.validator.validate({
      organizationId: authenticated.organizationId,
      scope: input.scope,
      grantedScopes: authenticated.scopes,
    });

    return {
      data: { valid: true, environment: 'sandbox', scope: input.scope },
      meta: {
        request_id: isRequestId(request.id) ? request.id : String(request.id),
      },
    };
  }
}
