import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { userIdentityRequired } from '@/common/errors/user-identity-required';
import {
  type RequestLifecycleState,
  getRequestLifecycle,
} from '@/common/http/request-lifecycle.hook';
import { markRequestAdmission } from '@/common/http/request-timing.hook';
import type { GradingOrchestratorPort } from '@/modules/gateway/application/grading-orchestrator.port';
import type { DispatchResult } from '@/modules/gateway/application/operation-dispatcher.port';
import type {
  RequestFor,
  ResponseFor,
} from '@/modules/gateway/application/operation-dispatcher.port';
import { takeCompletedReplay } from '@/modules/gateway/public/completed-idempotency-replay';
import type {
  GradedRequestExecutorPort,
  PreparedGradedInput,
} from '@/modules/gateway/public/graded-request-executor';
import type { IdempotencyBackgroundLifecycle } from '@/modules/idempotency/application/idempotency-service.port';
import { resolveIdempotencyKey } from '@/modules/idempotency/public/idempotency-key';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import type { MeteringFinalizerPort } from '@/modules/metering/application/metering-finalizer.port';
import { billBackgroundCompletion } from '@/modules/metering/public/background-completion-billing';
import {
  markGradedCompletionSettled,
  markGradedCompletionStarted,
} from '@/modules/metering/public/graded-request-timing';
import { getMeteringEvidence } from '@/modules/metering/public/metering-evidence';
import { getConcurrencyBackgroundLifecycle } from './concurrency-permit';

function requestLifecycle(
  request: AuthenticatedRequest,
): RequestLifecycleState {
  const lifecycle = getRequestLifecycle(request.raw);
  if (lifecycle === undefined) {
    throw new Error('request lifecycle state is missing');
  }
  return lifecycle;
}

function backgroundLifecycleFor(
  request: AuthenticatedRequest,
  lifecycle: RequestLifecycleState,
  finalizer: MeteringFinalizerPort,
): IdempotencyBackgroundLifecycle | undefined {
  const concurrency = getConcurrencyBackgroundLifecycle(request);
  return billBackgroundCompletion({
    requestId: String(request.id),
    receivedAt: lifecycle.receivedAt,
    evidence: getMeteringEvidence(request),
    finalizer,
    ...(concurrency === undefined ? {} : { inner: concurrency }),
    onCompletionSettled: () => markGradedCompletionSettled(request),
  });
}

export class GradedRequestExecutor implements GradedRequestExecutorPort {
  constructor(
    private readonly orchestrator: GradingOrchestratorPort,
    private readonly finalizer: MeteringFinalizerPort,
  ) {}

  async execute<K extends OperationId>(
    request: AuthenticatedRequest,
    operation: K,
    prepareInput: (
      signal: AbortSignal,
    ) =>
      | PreparedGradedInput<RequestFor<K>>
      | Promise<PreparedGradedInput<RequestFor<K>>>,
  ): Promise<DispatchResult<ResponseFor<K>>> {
    const lifecycle = requestLifecycle(request);
    let prepared: PreparedGradedInput<RequestFor<K>> | undefined;

    try {
      prepared = await prepareInput(lifecycle.signal);
      const authenticated = getAuthenticatedApiKey(request);
      const userId = request.aihubIdentity?.userId;
      if (userId === undefined || userId.trim().length === 0) {
        throw userIdentityRequired();
      }

      const metadata = {
        requestId: String(request.id),
        receivedAt: lifecycle.receivedAt,
        signal: lifecycle.signal,
        onDispatchStart: () => markRequestAdmission(request.raw),
        onAiServiceResultAvailable: () => markGradedCompletionStarted(request),
        organizationId: authenticated.organizationId,
        apiKeyId: authenticated.apiKeyId,
        environment: authenticated.environment,
        userId,
        scopes: authenticated.scopes,
      };
      const idempotency = OPERATION_CATALOG[operation].idempotency;
      let idempotencyKey: string | undefined;
      let completedReplay: ReturnType<typeof takeCompletedReplay>;
      let backgroundLifecycle: IdempotencyBackgroundLifecycle | undefined;
      if (idempotency !== 'none') {
        idempotencyKey = resolveIdempotencyKey(
          operation,
          request.headers['idempotency-key'],
        );
        completedReplay = takeCompletedReplay(
          request,
          operation,
          idempotencyKey,
        );
        backgroundLifecycle = backgroundLifecycleFor(
          request,
          lifecycle,
          this.finalizer,
        );
      }

      return await this.orchestrator.execute({
        operation,
        input: prepared.input,
        ...metadata,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(completedReplay === undefined ? {} : { completedReplay }),
        ...(backgroundLifecycle === undefined ? {} : { backgroundLifecycle }),
      });
    } finally {
      try {
        prepared?.release?.();
      } finally {
        lifecycle.dispose();
      }
    }
  }
}
