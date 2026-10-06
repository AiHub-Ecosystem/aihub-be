import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import { userIdentityRequired } from '@/common/errors/user-identity-required';
import { appConfig } from '@/config/runtime-configuration';
import { invalidUserIdentity } from '@/modules/identity/application/user-identity-errors';
import {
  USER_IDENTITY_RESOLVER,
  type UserIdentityResolverPort,
} from '@/modules/identity/application/user-identity-resolver.port';
import { addMeteringEvidence } from '@/modules/metering/application/metering-evidence';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from './authenticated-request';
import {
  type RequestEnvironmentConfig,
  isLocalAuthBypassEnabled,
} from './request-environment';
import { REQUIRED_OPERATION_METADATA } from './require-operation.decorator';

function configurationError(): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Authentication configuration is invalid',
    retryable: false,
  });
}

@Injectable()
export class UserIdentityGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(USER_IDENTITY_RESOLVER)
    private readonly resolver: UserIdentityResolverPort,
    @Inject(appConfig.KEY)
    private readonly configuration?: RequestEnvironmentConfig,
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

    const authenticated = getAuthenticatedApiKey(request);
    const header = request.headers['x-user-identity'];

    if (header === undefined) {
      if (
        this.configuration !== undefined &&
        isLocalAuthBypassEnabled(this.configuration) &&
        authenticated.organizationId === 'local-development'
      ) {
        request.aihubIdentity = {
          userId: 'local-development',
          organizationId: authenticated.organizationId,
          scopes: [],
        };
        addMeteringEvidence(request, { actorId: 'local-development' });
        return true;
      }

      throw userIdentityRequired();
    }

    if (typeof header !== 'string' || header.trim().length === 0) {
      throw invalidUserIdentity();
    }

    request.aihubIdentity = await this.resolver.resolve({
      value: header,
      organizationId: authenticated.organizationId,
    });
    addMeteringEvidence(request, { actorId: request.aihubIdentity.userId });
    return true;
  }
}
