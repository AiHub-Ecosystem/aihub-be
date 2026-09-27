import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type Observable, finalize } from 'rxjs';

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
    const reply = context.switchToHttp().getResponse<FastifyReply>();
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

    // The permit is closed over by the release half, so releasing is
    // structurally impossible to separate from acquiring — there is no
    // read-back that a wiring fault could invalidate. The request property is
    // kept because the Writing controller reads the background lifecycle from
    // it; it is not what releases the slot.
    const onResponseFinished = (): void => {
      void permit.responseFinished().catch(() => undefined);
    };
    reply.raw.once('finish', onResponseFinished);
    reply.raw.once('close', onResponseFinished);

    return next.handle().pipe(
      finalize(() => {
        reply.raw.off('finish', onResponseFinished);
        reply.raw.off('close', onResponseFinished);
        void permit.requestFinished().catch(() => undefined);
      }),
    );
  }
}
