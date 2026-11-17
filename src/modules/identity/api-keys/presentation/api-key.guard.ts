import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import {
  authenticationConfigurationInvalid,
  clientSecretMissingOrInvalid,
} from '@/common/errors/auth-boundary-errors';
import type { ClientIpSource } from '@/common/http/client-ip-source';
import { recordRejected } from '@/common/observability/rejected-metric';
import { constantTimeEquals } from '@/common/security/constant-time-equals';
import { clientSecretFrom } from '@/modules/auth/public/client-secret-header';
import {
  WEB_SESSION_CLIENT_SECRET,
  type WebSessionClientSecretPort,
} from '@/modules/auth/web-sessions/application/web-session-client-secret.port';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
  type AuthenticatedApiKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { isAiServiceScope } from '@/modules/identity/domain/api-key';
import { SANDBOX_API_KEY_RATE_LIMIT_RPM } from '@/modules/identity/shared/application/sandbox-api-key-rate-limit';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import {
  type RequestEnvironmentConfig,
  isLocalAuthBypassEnabled,
  resolveAihubEnvironment,
} from '@/modules/identity/shared/presentation/request-environment';
import {
  ADDITIONAL_OPERATION_SCOPES_METADATA,
  REQUIRED_OPERATION_METADATA,
} from '@/modules/identity/shared/presentation/require-operation.decorator';
import { openMeteringEvidence } from '@/modules/metering/public/metering-evidence';
import { RUNTIME_PRESENTATION_CONFIGURATION } from '@/modules/secrets/application/runtime-connection-configuration.port';
import {
  authenticateApiKey,
  forbidden,
  forwardedVisitorIp,
} from './authenticate-api-key';

function visitorIpForBffRequest(
  request: AuthenticatedRequest,
  secret: WebSessionClientSecretPort | undefined,
): string | undefined {
  const presented = clientSecretFrom(request);
  if (presented === undefined) return undefined;

  const expected = secret?.resolve();
  if (expected === undefined || expected.length === 0) {
    throw authenticationConfigurationInvalid({
      diagnostic: 'bff-client-secret-not-configured',
    });
  }
  if (!constantTimeEquals(presented, expected)) {
    recordRejected('auth');
    throw clientSecretMissingOrInvalid();
  }

  request.aihubClientIpSource = 'customer_web_bff' satisfies ClientIpSource;
  const visitorIp = forwardedVisitorIp(request);
  if (visitorIp === undefined) {
    throw authenticationConfigurationInvalid({
      diagnostic: 'bff-visitor-ip-missing-or-invalid',
    });
  }
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
    @Inject(RUNTIME_PRESENTATION_CONFIGURATION)
    private readonly configuration?: RequestEnvironmentConfig,
    @Optional()
    @Inject(WEB_SESSION_CLIENT_SECRET)
    private readonly webSessionClientSecret?: WebSessionClientSecretPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    let stage = 'operation_metadata';

    try {
      const operationId = this.reflector.getAllAndOverride<OperationId>(
        REQUIRED_OPERATION_METADATA,
        [context.getHandler(), context.getClass()],
      );

      if (operationId === undefined || !(operationId in OPERATION_CATALOG)) {
        throw authenticationConfigurationInvalid();
      }

      const operation = OPERATION_CATALOG[operationId];
      const additionalScopes =
        this.reflector.getAllAndOverride<readonly string[]>(
          ADDITIONAL_OPERATION_SCOPES_METADATA,
          [context.getHandler(), context.getClass()],
        ) ?? [];
      stage = 'runtime_configuration';
      const configuration = this.requireConfiguration();
      stage = 'environment_resolution';
      const environment = resolveAihubEnvironment(request, configuration);
      stage = 'bff_authentication';
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
        stage = 'metering_evidence';
        openMeteringEvidence(request, {
          operation: operationId,
          organizationId: authenticated.organizationId,
          apiKeyId: authenticated.apiKeyId,
          environment: authenticated.environment,
        });
        return true;
      }

      stage = 'api_key_authentication';
      const authenticated = await authenticateApiKey(
        request,
        this.authenticator,
        configuration,
        {
          ...(bffVisitorIp === undefined ? {} : { clientIp: bffVisitorIp }),
          forceFresh:
            isAiServiceScope(operation.requiredScope) ||
            additionalScopes.some(isAiServiceScope),
        },
      );
      const authorized =
        environment === 'sandbox'
          ? {
              ...authenticated,
              rateLimitRpm: Math.min(
                authenticated.rateLimitRpm,
                SANDBOX_API_KEY_RATE_LIMIT_RPM,
              ),
            }
          : authenticated;
      request.aihubAuth = authorized;
      stage = 'metering_evidence';
      openMeteringEvidence(request, {
        operation: operationId,
        organizationId: authorized.organizationId,
        apiKeyId: authorized.apiKeyId,
        environment: authorized.environment,
      });

      stage = 'scope_authorization';
      if (
        ![operation.requiredScope, ...additionalScopes].some((scope) =>
          authorized.scopes.includes(scope),
        )
      ) {
        throw forbidden();
      }

      return true;
    } catch (error) {
      const isServerError =
        error instanceof AppError
          ? error.httpStatus >= 500
          : error instanceof HttpException
            ? error.getStatus() >= 500
            : true;
      if (isServerError) {
        const correlationId = request.headers['x-correlation-id'];
        request.log.error({
          event: 'api_key_guard_internal_error',
          request_id: String(request.id),
          ...(typeof correlationId === 'string' &&
          /^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            correlationId,
          )
            ? { correlation_id: correlationId }
            : {}),
          stage,
          error_type: error instanceof Error ? error.name : typeof error,
          ...(error instanceof AppError && error.diagnostic !== undefined
            ? { error_diagnostic: error.diagnostic }
            : {}),
        });
      }
      throw error;
    }
  }

  private requireConfiguration(): RequestEnvironmentConfig {
    if (this.configuration === undefined) {
      throw authenticationConfigurationInvalid();
    }
    return this.configuration;
  }
}
