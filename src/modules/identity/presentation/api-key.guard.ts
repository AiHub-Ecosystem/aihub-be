import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OPERATION_CATALOG } from '../../../catalog/operation-catalog';
import type { OperationId } from '../../../catalog/operation-id';
import { AppError } from '../../../common/errors/app-error';
import { setRequestMeteringIdentity } from '../../../common/request-metering/request-metering-state';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
  type AuthenticatedApiKey,
} from '../application/api-key-authenticator.port';
import { hasRequiredScope } from '../application/authorization';
import {
  SANDBOX_ASSERTION_POLICY,
  type SandboxAssertionPolicyPort,
} from '../application/sandbox-assertion-policy.port';
import { authenticateApiKey, forbidden } from './authenticate-api-key';
import type { AuthenticatedRequest } from './authenticated-request';
import {
  isLocalAuthBypassEnabled,
  resolveAihubEnvironment,
} from './request-environment';
import { REQUIRED_OPERATION_METADATA } from './require-operation.decorator';

function configurationError(): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Authentication configuration is invalid',
    retryable: false,
  });
}

function localDevelopmentIdentity(
  operation: (typeof OPERATION_CATALOG)[OperationId],
  environment: string,
): AuthenticatedApiKey {
  return {
    organizationId: 'local-development',
    apiKeyId: 'local-development',
    environment,
    scopes: [operation.requiredScope],
    rateLimitRpm: 600,
    maxConcurrent: 20,
    monthlyRequestQuota: null,
    hardStopOnQuota: false,
  };
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(API_KEY_AUTHENTICATOR)
    private readonly authenticator: ApiKeyAuthenticatorPort,
    @Optional()
    @Inject(SANDBOX_ASSERTION_POLICY)
    private readonly sandboxPolicy?: SandboxAssertionPolicyPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const operationId = this.reflector.getAllAndOverride<OperationId>(
      REQUIRED_OPERATION_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (operationId === undefined || !(operationId in OPERATION_CATALOG)) {
      throw configurationError();
    }

    const operation = OPERATION_CATALOG[operationId];
    const environment = resolveAihubEnvironment(request);
    const header = request.headers['x-api-key'];

    if (
      environment === 'development' &&
      header === undefined &&
      isLocalAuthBypassEnabled()
    ) {
      const authenticated = localDevelopmentIdentity(operation, environment);
      request.aihubAuth = authenticated;
      setRequestMeteringIdentity(request, {
        operation: operationId,
        organizationId: authenticated.organizationId,
        apiKeyId: authenticated.apiKeyId,
        environment: authenticated.environment,
      });
      return true;
    }

    const authenticated = await authenticateApiKey(request, this.authenticator);
    const authorized =
      environment === 'sandbox'
        ? {
            ...authenticated,
            rateLimitRpm: Math.min(authenticated.rateLimitRpm, 5),
            sandboxOrganizationDispatchLimit:
              this.sandboxPolicy?.isConfiguredOrganization?.(
                authenticated.organizationId,
              )
                ? authenticated.monthlyRequestQuota
                : 25,
          }
        : authenticated;
    request.aihubAuth = authorized;
    setRequestMeteringIdentity(request, {
      operation: operationId,
      organizationId: authorized.organizationId,
      apiKeyId: authorized.apiKeyId,
      environment: authorized.environment,
    });

    if (!hasRequiredScope(authorized, operation.requiredScope)) {
      throw forbidden();
    }

    return true;
  }
}
