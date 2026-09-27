import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';

import { AppError } from '../../../common/errors/app-error';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
} from '../application/api-key-authenticator.port';
import {
  SANDBOX_ASSERTION_POLICY,
  type SandboxAssertionPolicyPort,
} from '../application/sandbox-assertion-policy.port';
import { authenticateApiKey, forbidden } from './authenticate-api-key';
import type { AuthenticatedRequest } from './authenticated-request';

function notFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: 'Resource was not found',
    retryable: false,
  });
}

/**
 * Authenticates a sandbox mint request.
 *
 * `ApiKeyGuard` cannot serve here: it resolves an operation id against
 * `OPERATION_CATALOG`, and every dispatch entry must name a downstream service,
 * a downstream path, and request and response contracts. Minting has no
 * downstream. Adding a synthetic entry to satisfy the guard would also place a
 * phantom proxy operation in the generated OpenAPI document and Postman
 * collection. Minting is declared instead in `PUBLIC_ROUTES`, which describes
 * it without giving it a dispatcher. The authentication step itself is shared
 * rather than copied, so both guards admit exactly the same keys.
 *
 * Authorization is membership of the configured sandbox allowlist rather than
 * a scope. A scope would have to be granted somewhere, and a scope granted by
 * mistake to a real tenant's key would let that tenant mint. Deployment
 * configuration is the narrower control.
 *
 * There is deliberately no development bypass here. `ApiKeyGuard` has one for
 * unauthenticated local work; minting produces a credential, and a route that
 * hands one out without a key is not something to leave switchable.
 */
@Injectable()
export class SandboxApiKeyGuard implements CanActivate {
  constructor(
    @Inject(API_KEY_AUTHENTICATOR)
    private readonly authenticator: ApiKeyAuthenticatorPort,
    @Inject(SANDBOX_ASSERTION_POLICY)
    private readonly policy: SandboxAssertionPolicyPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // No sandbox configured means this route does not exist for this
    // deployment. Answering 404 keeps its absence indistinguishable from a
    // build that never had the route.
    if (!this.policy.isEnabled()) {
      throw notFound();
    }

    const authenticated = await authenticateApiKey(request, this.authenticator);

    if (!this.policy.allows(authenticated.organizationId)) {
      throw forbidden();
    }

    return true;
  }
}
