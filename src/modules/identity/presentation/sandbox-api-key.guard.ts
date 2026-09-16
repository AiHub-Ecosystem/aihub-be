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
import type { AuthenticatedRequest } from './authenticated-request';
import { resolveAihubEnvironment } from './request-environment';

function notFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: 'Resource was not found',
    retryable: false,
  });
}

function forbidden(): AppError {
  return new AppError({
    code: 'FORBIDDEN',
    message: 'API key is not authorized for this operation',
    retryable: false,
  });
}

/**
 * Authenticates a sandbox mint request.
 *
 * `ApiKeyGuard` cannot serve here: it resolves an operation id against
 * `OPERATION_CATALOG`, and every catalog entry must name a downstream service,
 * a downstream path, and request and response contracts. Minting has no
 * downstream. Adding a synthetic entry to satisfy the guard would also place a
 * phantom operation in the generated OpenAPI document and Postman collection,
 * both of which are produced from that catalog. So this guard reuses the same
 * authenticator port and adds the one check the catalog cannot express.
 *
 * Authorization is membership of the configured sandbox allowlist rather than
 * a scope. A scope would have to be granted somewhere, and a scope granted by
 * mistake to a real tenant's key would let that tenant mint. Deployment
 * configuration is the narrower control.
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
    // build that never had the feature.
    if (!this.policy.isEnabled()) {
      throw notFound();
    }

    const environment = resolveAihubEnvironment(request);
    const header = request.headers['x-api-key'];
    const authenticated = await this.authenticator.authenticate({
      value: typeof header === 'string' ? header : '',
      environment,
      clientIp: request.ip.length === 0 ? 'unknown' : request.ip,
    });

    if (!this.policy.allows(authenticated.organizationId)) {
      throw forbidden();
    }

    request.aihubAuth = authenticated;
    return true;
  }
}
