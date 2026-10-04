import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';

import { userIdentityRequired } from '@/common/errors/user-identity-required';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
} from '@/modules/identity/application/api-key-authenticator.port';
import { invalidUserIdentity } from '@/modules/identity/application/user-identity-errors';
import {
  USER_IDENTITY_RESOLVER,
  type UserIdentityResolverPort,
} from '@/modules/identity/application/user-identity-resolver.port';

import { authenticateApiKey } from './authenticate-api-key';
import type { AuthenticatedRequest } from './authenticated-request';

/** Authenticates an API-key Public API Route that also resolves an End-User ID. */
@Injectable()
export class ApiKeyUserIdentityGuard implements CanActivate {
  constructor(
    @Inject(API_KEY_AUTHENTICATOR)
    private readonly authenticator: ApiKeyAuthenticatorPort,
    @Inject(USER_IDENTITY_RESOLVER)
    private readonly resolver: UserIdentityResolverPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authenticated = await authenticateApiKey(request, this.authenticator);
    const header = request.headers['x-user-identity'];

    if (header === undefined) {
      throw userIdentityRequired();
    }
    if (typeof header !== 'string' || header.trim().length === 0) {
      throw invalidUserIdentity();
    }

    const identity = await this.resolver.resolve({
      value: header,
      organizationId: authenticated.organizationId,
    });
    if (identity.organizationId !== authenticated.organizationId) {
      throw invalidUserIdentity();
    }

    request.aihubIdentity = identity;
    return true;
  }
}
