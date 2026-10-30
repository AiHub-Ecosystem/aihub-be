import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { userIdentityRequired } from '@/common/errors/user-identity-required';
import { recordRejected } from '@/common/observability/rejected-metric';
import { appConfig } from '@/config/runtime-configuration';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { isGradingScope } from '@/modules/identity/domain/api-key';
import {
  USER_IDENTITY_RESOLVER,
  type UserIdentityResolverPort,
} from '@/modules/identity/user-assertions/application/user-identity-resolver.port';

import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import type { RequestEnvironmentConfig } from '@/modules/identity/shared/presentation/request-environment';
import { REQUIRED_API_KEY_SCOPE_METADATA } from '@/modules/identity/shared/presentation/require-api-key-scope.decorator';
import { resolveUserIdentity } from '@/modules/identity/shared/presentation/resolve-user-identity';
import { authenticateApiKey, forbidden } from './authenticate-api-key';

/** Authenticates an API-key Public API Route that also resolves an End-User ID. */
@Injectable()
export class ApiKeyUserIdentityGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(API_KEY_AUTHENTICATOR)
    private readonly authenticator: ApiKeyAuthenticatorPort,
    @Inject(USER_IDENTITY_RESOLVER)
    private readonly resolver: UserIdentityResolverPort,
    @Inject(appConfig.KEY)
    private readonly configuration: RequestEnvironmentConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const requiredScope = this.reflector.getAllAndOverride<string>(
      REQUIRED_API_KEY_SCOPE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    const authenticated = await authenticateApiKey(
      request,
      this.authenticator,
      this.configuration,
      {
        forceFresh:
          requiredScope !== undefined && isGradingScope(requiredScope),
      },
    );
    if (
      requiredScope !== undefined &&
      !authenticated.scopes.includes(requiredScope)
    ) {
      throw forbidden();
    }
    const header = request.headers['x-user-identity'];

    if (header === undefined) {
      recordRejected('auth');
      throw userIdentityRequired();
    }

    request.aihubIdentity = await resolveUserIdentity(
      header,
      authenticated.organizationId,
      this.resolver,
    );
    return true;
  }
}
