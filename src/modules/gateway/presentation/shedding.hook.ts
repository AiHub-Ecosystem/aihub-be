import type { FastifyInstance } from 'fastify';

import { createErrorEnvelope } from '@/common/errors/error-envelope';
import { outageRetryAfterMs } from '@/common/errors/retry-jitter';
import { recordRequestFailure } from '@/common/http/request-failure.recorder';
import { markRequestAdmission } from '@/common/http/request-timing.hook';
import { recordRejected } from '@/common/observability/rejected-metric';
import { isRequestId } from '@/common/request-context/request-id';
import {
  type RequestTier,
  requestTierOf,
  shedsAtLevel,
} from '@/modules/gateway/application/shedding/request-tier';
import type { SheddingLevelPort } from '@/modules/gateway/application/shedding/shedding-level.port';

/** A refused request costs one lookup and one small reply, well inside 50 ms. */
export function registerSheddingGuard(
  instance: Pick<FastifyInstance, 'addHook'>,
  level: SheddingLevelPort,
  record: (tier: RequestTier, outcome: 'admitted' | 'shed') => void = () =>
    undefined,
): void {
  instance.addHook('onRequest', (request, reply, done) => {
    const tier = requestTierOf(request.method, request.url);
    if (!shedsAtLevel(tier, level.current())) {
      record(tier, 'admitted');
      done();
      return;
    }

    // This reply never reaches the exception filter, so the refusal records its
    // own code for the Request Completion Event and sets its own header.
    const retryAfterMs = outageRetryAfterMs();
    markRequestAdmission(request.raw);
    recordRequestFailure(request, 'SERVICE_OVERLOADED');
    record(tier, 'shed');
    recordRejected('concurrency');
    reply
      .code(503)
      .header('Retry-After', String(Math.ceil(retryAfterMs / 1_000)))
      .send(
        createErrorEnvelope({
          code: 'SERVICE_OVERLOADED',
          message: 'Service is temporarily overloaded',
          requestId: isRequestId(request.id) ? request.id : 'unknown',
          retryable: true,
          retryAfterMs,
        }),
      );
  });
}
