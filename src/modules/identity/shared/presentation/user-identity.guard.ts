import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { authenticationConfigurationInvalid } from '@/common/errors/auth-boundary-errors';
import { userIdentityRequired } from '@/common/errors/user-identity-required';
import { recordRejected } from '@/common/observability/metrics/rejected-metric';
import {
  USER_IDENTITY_RESOLVER,
  type UserIdentityResolverPort,
} from '@/modules/identity/user-assertions/application/user-identity-resolver.port';
import { addMeteringEvidence } from '@/modules/metering/public/metering-evidence';
import { RUNTIME_PRESENTATION_CONFIGURATION } from '@/modules/secrets/application/runtime-connection-configuration.port';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from './authenticated-request';
import {
  LOCAL_DEVELOPMENT_ORGANIZATION_ID,
  type RequestEnvironmentConfig,
  isLocalAuthBypassEnabled,
} from './request-environment';
import { REQUIRED_OPERATION_METADATA } from './require-operation.decorator';
import { resolveUserIdentity } from './resolve-user-identity';

@Injectable()
export class UserIdentityGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(USER_IDENTITY_RESOLVER)
    private readonly resolver: UserIdentityResolverPort,
    @Inject(RUNTIME_PRESENTATION_CONFIGURATION)
    private readonly configuration?: RequestEnvironmentConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const operationId = this.reflector.getAllAndOverride<OperationId>(
      REQUIRED_OPERATION_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (operationId === undefined || !(operationId in OPERATION_CATALOG)) {
      throw authenticationConfigurationInvalid();
    }

    const authenticated = getAuthenticatedApiKey(request);
    const header = request.headers['x-user-identity'];

    if (header === undefined) {
      if (
        this.configuration !== undefined &&
        isLocalAuthBypassEnabled(this.configuration) &&
        authenticated.organizationId === LOCAL_DEVELOPMENT_ORGANIZATION_ID
      ) {
        request.aihubIdentity = {
          userId: 'local-development',
          organizationId: authenticated.organizationId,
          scopes: [],
          mode: 'declared_id',
        };
        addMeteringEvidence(request, { actorId: 'local-development' });
        return true;
      }

      recordRejected('auth');
      throw userIdentityRequired();
    }

    request.aihubIdentity = await resolveUserIdentity(
      header,
      authenticated.organizationId,
      this.resolver,
    );
    addMeteringEvidence(request, { actorId: request.aihubIdentity.userId });
    return true;
  }
}
