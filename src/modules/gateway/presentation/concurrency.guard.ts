import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';

import { AppError } from '../../../common/errors/app-error';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '../../identity/presentation/authenticated-request';
import {
  CONCURRENCY_LIMITER,
  type ConcurrencyLimiterPort,
} from '../application/concurrency-limiter.port';
import { createConcurrencyPermit } from './concurrency-permit';

function concurrencyLimited(retryAfterMs: number): AppError {
  return new AppError({
    code: 'CONCURRENCY_LIMIT',
    message: 'Concurrency limit exceeded',
    retryable: true,
    retryAfterMs,
  });
}

@Injectable()
export class ConcurrencyGuard implements CanActivate {
  constructor(
    @Inject(CONCURRENCY_LIMITER)
    private readonly limiter: ConcurrencyLimiterPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authenticated = getAuthenticatedApiKey(request);
    const decision = await this.limiter.acquire({
      organizationId: authenticated.organizationId,
      maxConcurrent: authenticated.maxConcurrent,
      requestId: String(request.id),
    });

    if (!decision.allowed) {
      throw concurrencyLimited(decision.retryAfterMs);
    }

    request.aihubConcurrency = createConcurrencyPermit(decision.lease);
    return true;
  }
}
