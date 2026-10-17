import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import { appConfig } from '@/config/runtime-configuration';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import type { RequestEnvironmentConfig } from '@/modules/identity/shared/presentation/request-environment';
import { authenticateApiKey, forwardedVisitorIp } from './authenticate-api-key';
import { SANDBOX_API_KEY_RATE_LIMIT_RPM } from './sandbox-api-key-rate-limit';

/**
 * Authenticates demo key checks without entering the metered grading chain.
 *
 * The stored environment binding is not forced to be Sandbox here: a legacy
 * `aihub_sk_` key may still name more than one environment, and the demo page's
 * selection is checked against the stored binding in the use case, where the
 * scope it must also carry is known.
 */
@Injectable()
export class SandboxDemoKeyValidationGuard implements CanActivate {
  constructor(
    @Inject(API_KEY_AUTHENTICATOR)
    private readonly authenticator: ApiKeyAuthenticatorPort,
    @Inject(appConfig.KEY)
    private readonly configuration: RequestEnvironmentConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const visitorIp = forwardedVisitorIp(request);
    if (visitorIp === undefined) {
      throw new AppError({
        code: 'IDENTITY_PROVIDER_UNAVAILABLE',
        message: 'Demo key validation is unavailable',
        retryable: true,
      });
    }
    const authenticated = await authenticateApiKey(
      request,
      this.authenticator,
      this.configuration,
      { clientIp: visitorIp, forceFresh: true },
    );

    request.aihubAuth = {
      ...authenticated,
      rateLimitRpm: Math.min(
        authenticated.rateLimitRpm,
        SANDBOX_API_KEY_RATE_LIMIT_RPM,
      ),
    };
    return true;
  }
}
