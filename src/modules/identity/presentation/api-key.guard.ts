import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OPERATION_CATALOG } from '../../../catalog/operation-catalog';
import type { OperationId } from '../../../catalog/operation-id';
import { AppError } from '../../../common/errors/app-error';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
  type AuthenticatedApiKey,
} from '../application/api-key-authenticator.port';
import { hasRequiredScope } from '../application/authorization';
import type { AuthenticatedRequest } from './authenticated-request';
import {
  isLocalAuthBypassEnabled,
  resolveAihubEnvironment,
} from './request-environment';
import { REQUIRED_OPERATION_METADATA } from './require-operation.decorator';

function forbidden(): AppError {
  return new AppError({
    code: 'FORBIDDEN',
    message: 'API key is not authorized for this operation',
    retryable: false,
  });
}

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
      request.aihubAuth = localDevelopmentIdentity(operation, environment);
      return true;
    }

    const apiKey = typeof header === 'string' ? header : '';
    const authenticated = await this.authenticator.authenticate({
      value: apiKey,
      environment,
      clientIp: request.ip.length === 0 ? 'unknown' : request.ip,
    });

    if (!hasRequiredScope(authenticated, operation.requiredScope)) {
      throw forbidden();
    }

    request.aihubAuth = authenticated;
    return true;
  }
}
