import type { FastifyReply } from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { matchesPathTemplate } from '@/catalog/path-template';
import { AppError, internalError } from '@/common/errors/app-error';
import { userIdentityRequired } from '@/common/errors/user-identity-required';
import { getRequestLifecycle } from '@/common/http/request-lifecycle.hook';
import { markRequestAdmission } from '@/common/http/request-timing.hook';
import { routeTemplate } from '@/common/http/request-tracing.hook';
import type { GradedPipelineContext } from '@/modules/gateway/application/graded-request/graded-pipeline.port';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import {
  markGradedCompletionSettled,
  markGradedCompletionStarted,
  setGradedRequestDimensions,
} from '@/modules/metering/public/graded-request-timing';
import {
  addMeteringEvidence,
  getMeteringEvidence,
} from '@/modules/metering/public/metering-evidence';
import { reportStanding } from './rate-limit-standing';

export function createGradedPipelineContext<K extends OperationId>(
  request: AuthenticatedRequest,
  reply: FastifyReply,
  operation: K,
  prepareInput: GradedPipelineContext<K>['prepareInput'],
  onDispatchResult?: GradedPipelineContext<K>['onDispatchResult'],
): GradedPipelineContext<K> {
  if (
    !matchesPathTemplate(
      OPERATION_CATALOG[operation].path,
      routeTemplate(request),
    )
  ) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Graded admission is not wired for this route',
      retryable: false,
    });
  }
  const evidence = getMeteringEvidence(request);
  if (evidence === undefined || evidence.operation !== operation) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Graded admission is not wired for this route',
      retryable: false,
    });
  }
  const lifecycle = getRequestLifecycle(request.raw);
  if (lifecycle === undefined) {
    throw internalError('request lifecycle state is missing');
  }
  const identity = request.aihubIdentity;
  if (identity === undefined) throw userIdentityRequired();

  return {
    requestId: String(request.id),
    receivedAt: lifecycle.receivedAt,
    signal: lifecycle.signal,
    dispose: lifecycle.dispose,
    operation,
    authenticated: getAuthenticatedApiKey(request),
    identity,
    ...(OPERATION_CATALOG[operation].idempotency !== 'none' &&
    typeof request.headers['idempotency-key'] === 'string'
      ? { idempotencyKey: request.headers['idempotency-key'] }
      : {}),
    metering: {
      evidence,
      setDimensions: (dimensions) =>
        setGradedRequestDimensions(request, dimensions),
      addEvidence: (evidence) => addMeteringEvidence(request, evidence),
      markCompletionStarted: () => markGradedCompletionStarted(request),
      markCompletionSettled: () => markGradedCompletionSettled(request),
    },
    onRateLimitStanding: (standing) => reportStanding(reply, standing),
    markAdmission: () => markRequestAdmission(request.raw),
    ...(onDispatchResult === undefined ? {} : { onDispatchResult }),
    prepareInput,
  };
}
