import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import { recordRejected } from '@/common/observability/rejected-metric';
import {
  RATE_LIMITER,
  type RateLimiterPort,
} from '@/modules/gateway/application/rate-limiter.port';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { reportStanding } from './rate-limit-standing';

/**
 * The plain per-key rate limit for routes outside the graded-request chain
 * (uploads, sandbox). Graded requests are admitted by `GradedAdmissionGuard`,
 * which applies this same limit together with the retry budget and the quota.
 *
 * Lives in `gateway` rather than any one operation's module: rate limiting
 * applies to every operation, keyed on the identity `ApiKeyGuard` already
 * attached to the request, and the port it consumes (`RATE_LIMITER`) is
 * already owned here.
 */
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
    reportStanding(context, decision.standing);

    if (!decision.allowed) {
      recordRejected('rate_limit');
      throw new AppError({
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded',
        retryable: true,
        ...(decision.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: decision.retryAfterMs }),
      });
    }

    return true;
  }
}
