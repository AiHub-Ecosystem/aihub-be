import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AppError } from '@/common/errors/app-error';
import { recordRejected } from '@/common/observability/metrics/rejected-metric';
import {
  CONTENT_RATE_LIMITER,
  type ContentRateLimiterPort,
} from '@/modules/content-proxy/application/content-rate-limiter.port';

@Injectable()
export class ContentRateLimitGuard implements CanActivate {
  constructor(
    @Inject(CONTENT_RATE_LIMITER)
    private readonly limiter: ContentRateLimiterPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const decision = await this.limiter.consume(request.ip ?? 'unknown');
    if (!decision.allowed) {
      recordRejected('rate_limit');
      throw new AppError({
        code: 'RATE_LIMITED',
        message: 'Request rate limit exceeded',
        retryable: true,
        retryAfterMs: decision.retryAfterMs,
      });
    }
    return true;
  }
}
