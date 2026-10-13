import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import type { ClientIpSource } from '@/common/http/client-ip-source';
import { clientSecretFrom } from '@/common/http/client-secret-header';
import { constantTimeEquals } from '@/common/security/constant-time-equals';
import { appConfig } from '@/config/runtime-configuration';
import {
  WEB_SESSION_CLIENT_SECRET,
  type WebSessionClientSecretPort,
} from '@/modules/auth/application/web-session-client-secret.port';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
  type AuthenticatedApiKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { isGradingScope } from '@/modules/identity/domain/api-key';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import {
  type RequestEnvironmentConfig,
  isLocalAuthBypassEnabled,
  resolveAihubEnvironment,
} from '@/modules/identity/shared/presentation/request-environment';
import { REQUIRED_OPERATION_METADATA } from '@/modules/identity/shared/presentation/require-operation.decorator';
import { openMeteringEvidence } from '@/modules/metering/application/metering-evidence';
import {
  authenticateApiKey,
  forbidden,
  forwardedVisitorIp,
} from './authenticate-api-key';

function configurationError(): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Authentication configuration is invalid',
    retryable: false,
  });
}

function visitorIpForBffRequest(
  request: AuthenticatedRequest,
  secret: WebSessionClientSecretPort | undefined,
): string | undefined {
  const presented = clientSecretFrom(request);
  if (presented === undefined) return undefined;

  const expected = secret?.resolve();
  if (expected === undefined || expected.length === 0) {
    throw configurationError();
  }
  if (!constantTimeEquals(presented, expected)) {
    throw new AppError({
      code: 'UNAUTHORIZED',
      message: 'Client secret is missing or invalid',
      retryable: false,
    });
  }

  const visitorIp = forwardedVisitorIp(request);
  if (visitorIp === undefined) {
    throw configurationError();
  }
  request.aihubClientIpSource = 'customer_web_bff' satisfies ClientIpSource;
  return visitorIp;
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
    allowedEnvironments: [environment],
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
    @Inject(appConfig.KEY)
    private readonly configuration?: RequestEnvironmentConfig,
    @Optional()
    @Inject(WEB_SESSION_CLIENT_SECRET)
    private readonly webSessionClientSecret?: WebSessionClientSecretPort,
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
    const configuration = this.requireConfiguration();
    const environment = resolveAihubEnvironment(request, configuration);
    const bffVisitorIp = visitorIpForBffRequest(
      request,
      this.webSessionClientSecret,
    );
    const header = request.headers['x-api-key'];

    if (
      environment === 'development' &&
      header === undefined &&
      isLocalAuthBypassEnabled(configuration)
    ) {
      const authenticated = localDevelopmentIdentity(operation, environment);
      request.aihubAuth = authenticated;
      openMeteringEvidence(request, {
        operation: operationId,
        organizationId: authenticated.organizationId,
        apiKeyId: authenticated.apiKeyId,
        environment: authenticated.environment,
      });
      return true;
    }

    const authenticated = await authenticateApiKey(
      request,
      this.authenticator,
      configuration,
      {
        ...(bffVisitorIp === undefined ? {} : { clientIp: bffVisitorIp }),
        forceFresh: isGradingScope(operation.requiredScope),
      },
    );
    const authorized =
      environment === 'sandbox'
        ? {
            ...authenticated,
            rateLimitRpm: Math.min(authenticated.rateLimitRpm, 5),
          }
        : authenticated;
    request.aihubAuth = authorized;
    openMeteringEvidence(request, {
      operation: operationId,
      organizationId: authorized.organizationId,
      apiKeyId: authorized.apiKeyId,
      environment: authorized.environment,
    });

    if (!authorized.scopes.includes(operation.requiredScope)) {
      throw forbidden();
    }

    return true;
  }

  private requireConfiguration(): RequestEnvironmentConfig {
    if (this.configuration === undefined) throw configurationError();
    return this.configuration;
  }
}
