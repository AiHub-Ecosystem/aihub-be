import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import {
  backgroundWorkSettled,
  backgroundWorkStarted,
} from '@/common/background-work-tracker';
import { AppError } from '@/common/errors/app-error';
import { userIdentityRequired } from '@/common/errors/user-identity-required';
import { recordRejected } from '@/common/observability/rejected-metric';
import type {
  IdempotencyBackgroundLifecycle,
  IdempotencyServicePort,
} from '@/modules/idempotency/application/idempotency-service.port';
import { resolveIdempotencyKey } from '@/modules/idempotency/public/idempotency-key';
import type { MeteringFinalizerPort } from '@/modules/metering/application/metering-finalizer.port';
import { billBackgroundCompletion } from '@/modules/metering/public/background-completion-billing';
import {
  type AdmitGradedRequestInput,
  admitGradedRequest,
  gradedAdmissionPolicy,
  gradedAdmissionRefusal,
} from './admit-graded-request';
import { findCompletedWritingReplay } from './completed-writing-replay';
import type {
  ConcurrencyLease,
  ConcurrencyLimiterPort,
} from './concurrency-limiter.port';
import type { GradedAdmissionPort } from './graded-admission.port';
import {
  GRADED_PIPELINE_COMPLETION,
  type GradedPipelineContext,
  type GradedPipelineDispatchResult,
  type GradedPipelineEnginePort,
  type GradedPipelineMetering,
  type PreparedGradedInput,
} from './graded-pipeline.port';
import type { GradingOrchestratorPort } from './grading-orchestrator.port';
import type { RequestFor, ResponseFor } from './operation-dispatcher.port';

interface ConcurrencyPermitLifecycle extends IdempotencyBackgroundLifecycle {
  requestFinished(): Promise<void>;
  isReleased(): boolean;
}

function concurrencyLimited(retryAfterMs: number): AppError {
  return new AppError({
    code: 'CONCURRENCY_LIMIT',
    message: 'Concurrency limit exceeded',
    retryable: true,
    retryAfterMs,
  });
}

function concurrencyPermit(
  lease: ConcurrencyLease,
): ConcurrencyPermitLifecycle {
  let backgroundStarted = false;
  let backgroundSettled = false;
  let requestSettled = false;
  let releaseAttempt: Promise<void> | undefined;
  let released = false;

  const releaseIfSettled = (): Promise<void> => {
    if (releaseAttempt !== undefined) return releaseAttempt;
    if (!requestSettled || (backgroundStarted && !backgroundSettled)) {
      return Promise.resolve();
    }
    releaseAttempt = Promise.resolve()
      .then(() => lease.release())
      .then(() => {
        released = true;
        return undefined;
      });
    return releaseAttempt;
  };

  return {
    started: () => {
      if (backgroundStarted) return;
      backgroundStarted = true;
      backgroundWorkStarted();
    },
    settled: async () => {
      if (backgroundSettled) return releaseAttempt ?? Promise.resolve();
      backgroundSettled = true;
      try {
        await releaseIfSettled();
      } finally {
        if (backgroundStarted) backgroundWorkSettled();
      }
    },
    requestFinished: async () => {
      requestSettled = true;
      await releaseIfSettled();
    },
    isReleased: () => released,
  };
}

function idempotencyKeyForAdmission<K extends OperationId>(
  operation: K,
  rawKey: string | undefined,
): string | undefined {
  if (
    OPERATION_CATALOG[operation].idempotency === 'none' ||
    rawKey === undefined
  ) {
    return undefined;
  }
  try {
    return resolveIdempotencyKey(operation, rawKey);
  } catch (error) {
    if (error instanceof AppError && error.code === 'INVALID_REQUEST') {
      return undefined;
    }
    throw error;
  }
}

/** Owns admission, concurrency, dispatch, replay, metering and late settlement for graded routes. */
export class GradedPipelineEngine implements GradedPipelineEnginePort {
  constructor(
    private readonly orchestrator: GradingOrchestratorPort,
    private readonly finalizer: MeteringFinalizerPort,
    private readonly admission: GradedAdmissionPort,
    private readonly concurrencyLimiter: ConcurrencyLimiterPort,
    private readonly idempotency: IdempotencyServicePort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute<K extends OperationId>(
    context: GradedPipelineContext<K>,
  ): Promise<GradedPipelineDispatchResult<ResponseFor<K>>> {
    const { operation, authenticated, identity, metering } = context;
    let prepared: PreparedGradedInput<RequestFor<K>> | undefined;
    let permit: ConcurrencyPermitLifecycle | undefined;
    let idempotencyKey: string | undefined;
    let completedReplay: Awaited<
      ReturnType<typeof findCompletedWritingReplay>
    > = undefined;
    let releaseTransferred = false;

    try {
      const userId = identity.userId;
      if (userId === undefined || userId.trim().length === 0) {
        throw userIdentityRequired();
      }

      const admissionIdempotencyKey = idempotencyKeyForAdmission(
        operation,
        context.idempotencyKey,
      );
      const admissionInput: AdmitGradedRequestInput = {
        apiKeyId: authenticated.apiKeyId,
        rateLimitRpm: authenticated.rateLimitRpm,
        organizationId: authenticated.organizationId,
        requestId: context.requestId,
        operation,
        ...(admissionIdempotencyKey === undefined
          ? {}
          : { idempotencyKey: admissionIdempotencyKey }),
        environment:
          authenticated.environment === 'sandbox' ? 'sandbox' : 'production',
        monthlyRequestQuota: authenticated.monthlyRequestQuota,
        hardStopOnQuota: authenticated.hardStopOnQuota,
      };
      const policy = gradedAdmissionPolicy(admissionInput);
      metering.setDimensions({
        operation,
        identityMode: identity.mode ?? 'unknown',
        retryBudget: policy.retryBudget,
      });

      const decision = await admitGradedRequest(this.admission, admissionInput);
      context.onRateLimitStanding?.(decision.rate);
      if (decision.stage === 'rate_limit') {
        context.markAdmission();
        recordRejected('rate_limit');
        throw gradedAdmissionRefusal(
          decision,
          authenticated.organizationId,
          () => this.now(),
        );
      }
      if (decision.stage === 'retry_budget') {
        context.markAdmission();
        throw gradedAdmissionRefusal(
          decision,
          authenticated.organizationId,
          () => this.now(),
        );
      }

      metering.addEvidence({ quotaTracked: policy.quotaTracked });
      if (decision.stage === 'quota') {
        try {
          prepared = await context.prepareInput(context.signal);
          completedReplay = await findCompletedWritingReplay(this.idempotency, {
            organizationId: authenticated.organizationId,
            operation,
            idempotencyKey: admissionInput.idempotencyKey,
            actorId: userId,
            requestBody: prepared.input,
          });
        } catch {
          // A quota bypass requires a valid body and a confirmed stored replay.
        }
        if (completedReplay === undefined) {
          context.markAdmission();
          recordRejected('quota');
          throw gradedAdmissionRefusal(
            decision,
            authenticated.organizationId,
            () => this.now(),
          );
        }
      } else if (decision.quotaUnverified) {
        metering.addEvidence({ quotaUnverified: true });
      }

      const concurrency = await this.concurrencyLimiter.acquire({
        organizationId: authenticated.organizationId,
        maxConcurrent: authenticated.maxConcurrent,
        requestId: context.requestId,
        environment: authenticated.environment,
      });
      if (!concurrency.allowed) {
        recordRejected('concurrency');
        throw concurrencyLimited(concurrency.retryAfterMs);
      }
      permit = concurrencyPermit(concurrency.lease);

      if (prepared === undefined) {
        prepared = await context.prepareInput(context.signal);
      }
      if (OPERATION_CATALOG[operation].idempotency !== 'none') {
        idempotencyKey = resolveIdempotencyKey(
          operation,
          context.idempotencyKey,
        );
      }

      const backgroundLifecycle =
        OPERATION_CATALOG[operation].idempotency === 'none'
          ? undefined
          : billBackgroundCompletion({
              requestId: context.requestId,
              receivedAt: context.receivedAt,
              evidence: metering.evidence,
              finalizer: this.finalizer,
              onCompletionSettled: () => metering.markCompletionSettled(),
              inner: permit,
            });

      const result = await this.orchestrator.execute({
        operation,
        input: prepared.input,
        requestId: context.requestId,
        receivedAt: context.receivedAt,
        signal: context.signal,
        onDispatchStart: () => context.markAdmission(),
        onAiServiceResultAvailable: () => metering.markCompletionStarted(),
        organizationId: authenticated.organizationId,
        apiKeyId: authenticated.apiKeyId,
        environment: authenticated.environment,
        userId,
        ...(identity.mode === undefined ? {} : { identityMode: identity.mode }),
        scopes: authenticated.scopes,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(completedReplay === undefined ? {} : { completedReplay }),
        ...(backgroundLifecycle === undefined ? {} : { backgroundLifecycle }),
      });
      await context.onDispatchResult?.(result);
      if (permit === undefined) return result;
      const responsePermit = permit;
      releaseTransferred = true;
      return {
        ...result,
        [GRADED_PIPELINE_COMPLETION]: async () => {
          await this.finishRequest(responsePermit, metering);
        },
      };
    } finally {
      try {
        prepared?.release?.();
      } finally {
        try {
          if (permit !== undefined && !releaseTransferred) {
            await this.finishRequest(permit, metering);
          }
        } finally {
          context.dispose();
        }
      }
    }
  }

  private async finishRequest(
    permit: ConcurrencyPermitLifecycle,
    metering: GradedPipelineMetering,
  ): Promise<void> {
    try {
      await permit.requestFinished();
    } catch {
      // A failed release is retried by the limiter and cannot rewrite the response.
    }
    if (permit.isReleased()) metering.markCompletionSettled();
  }
}
