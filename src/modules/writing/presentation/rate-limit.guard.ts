import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';

import { AppError } from '../../../common/errors/app-error';
import {
  RATE_LIMITER,
  type RateLimiterPort,
} from '../../gateway/application/rate-limiter.port';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '../../identity/presentation/authenticated-request';

function rateLimited(retryAfterMs: number | undefined): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Rate limit exceeded',
    httpStatus: 429,
    retryable: true,
    ...(retryAfterMs === undefined
      ? {}
      : { details: { retry_after_ms: retryAfterMs } }),
  });
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(RATE_LIMITER)
    private readonly limiter: RateLimiterPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authenticated = getAuthenticatedApiKey(request);
    const decision = await this.limiter.consume({
      keyId: authenticated.apiKeyId,
      limit: authenticated.rateLimitRpm,
    });

    if (!decision.allowed) {
      throw rateLimited(decision.retryAfterMs);
    }

    return true;
  }
}
