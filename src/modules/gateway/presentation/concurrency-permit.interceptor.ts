import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, defer, from, lastValueFrom } from 'rxjs';

import { AppError } from '@/common/errors/app-error';
import {
  CONCURRENCY_LIMITER,
  type ConcurrencyLimiterPort,
} from '@/modules/gateway/application/concurrency-limiter.port';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { markGradedCompletionSettled } from '@/modules/metering/public/graded-request-timing';
import { createConcurrencyPermit } from './concurrency-permit';

function concurrencyLimited(retryAfterMs: number): AppError {
  return new AppError({
    code: 'CONCURRENCY_LIMIT',
    message: 'Concurrency limit exceeded',
    retryable: true,
    retryAfterMs,
  });
}

/**
 * Acquires and releases a concurrency permit as one unit. A graded route cannot
 * be wired with the acquire half and not the release half, and there is no
 * load-ordering assumption between a separate guard and a separate interceptor:
 * both halves live in this class (ADR-0058).
 */
@Injectable()
export class ConcurrencyPermitInterceptor implements NestInterceptor {
  constructor(
    @Inject(CONCURRENCY_LIMITER)
    private readonly limiter: ConcurrencyLimiterPort,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authenticated = getAuthenticatedApiKey(request);
    const decision = await this.limiter.acquire({
      organizationId: authenticated.organizationId,
      maxConcurrent: authenticated.maxConcurrent,
      requestId: String(request.id),
      environment: authenticated.environment,
    });

    if (!decision.allowed) {
      throw concurrencyLimited(decision.retryAfterMs);
    }

    const permit = createConcurrencyPermit(decision.lease);
    request.aihubConcurrency = permit;
    return defer(() => from(handleWithPermit(next, permit, request)));
  }
}

async function handleWithPermit(
  next: CallHandler,
  permit: ReturnType<typeof createConcurrencyPermit>,
  request: AuthenticatedRequest,
): Promise<unknown> {
  try {
    return await lastValueFrom(next.handle());
  } finally {
    await permit.requestFinished().catch(() => undefined);
    if (permit.isReleased()) markGradedCompletionSettled(request.raw);
  }
}
