import { AppError } from '@/common/errors/app-error';
import type { SpeakingAudio } from '@/contracts/speaking/grading';
import type { SpeakingV2QuestionResult } from '@/contracts/speaking/v2/question-result';
import type { ConcurrencyLimiterPort } from '@/modules/gateway/application/concurrency-limiter.port';
import type { GradingOrchestratorPort } from '@/modules/gateway/application/graded-request/grading-orchestrator.port';
import type { SandboxDispatchBudgetPort } from '@/modules/gateway/public/sandbox-dispatch-budget';
import type { MeteringFinalizerPort } from '@/modules/metering/application/usage-recording/metering-finalizer.port';
import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/audio/speaking-audio-upload.port';
import type { SpeakingV2ResultOwnershipPort } from '@/modules/speaking/application/speaking-v2-result-ownership.port';
import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';
import {
  SPEAKING_GRADING_JOB_ERRORS,
  type SpeakingGradingJob,
  type SpeakingGradingJobError,
} from './speaking-grading-job';
import { SPEAKING_GRADING_JOB_POLICY } from './speaking-grading-job.policy';
import type {
  SpeakingGradingJobQueuePort,
  SpeakingGradingJobRepositoryPort,
} from './speaking-grading-job.port';

const QUESTION_GRADING = 'speaking.v2.question-grading' as const;
const AUDIO_ASSET_EXPIRED: SpeakingGradingJobError = {
  code: 'AUDIO_ASSET_EXPIRED',
  message: 'Speaking audio asset has expired',
  retryable: SPEAKING_GRADING_JOB_ERRORS.AUDIO_ASSET_EXPIRED.retryable,
};

export interface ProcessSpeakingGradingJobDependencies {
  readonly repository: Pick<
    SpeakingGradingJobRepositoryPort,
    'claim' | 'returnToQueue' | 'markDispatchStarted' | 'succeed' | 'fail'
  >;
  readonly queue: Pick<SpeakingGradingJobQueuePort, 'enqueue'>;
  readonly audioRepository: Pick<
    SpeakingAudioUploadRepositoryPort,
    'findUpload'
  >;
  readonly audioStorage: Pick<SpeakingAudioAssetStoragePort, 'readObject'>;
  readonly concurrencyLimiter: ConcurrencyLimiterPort;
  readonly orchestrator: GradingOrchestratorPort;
  readonly resultOwnership: Pick<SpeakingV2ResultOwnershipPort, 'record'>;
  readonly finalizer: MeteringFinalizerPort;
  readonly sandboxBudget: Pick<SandboxDispatchBudgetPort, 'release'>;
  readonly now?: () => Date;
}

function jobError(error: unknown): SpeakingGradingJobError {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.publicMessage ?? error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'Speaking grading failed',
    retryable: false,
  };
}

function meteringOutcome(error: unknown) {
  if (!(error instanceof AppError)) return 'internal_error' as const;
  return error.httpStatus >= 500
    ? ('downstream_error' as const)
    : ('client_error' as const);
}

/** Claims once, holds the Organization permit through dispatch and settlement, and never retries a marked call. */
export class ProcessSpeakingGradingJob {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: ProcessSpeakingGradingJobDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(input: {
    readonly jobId: string;
    readonly environment: SpeakingAudioEnvironment;
  }): Promise<void> {
    const now = this.now();
    const job = await this.dependencies.repository.claim({
      jobId: input.jobId,
      now,
      leaseExpiresAt: new Date(
        now.getTime() + SPEAKING_GRADING_JOB_POLICY.claimLeaseMs,
      ),
      // The queue deadline is enforced atomically at claim: an outage that
      // replays queued BullMQ wake-ups cannot dispatch and bill expired jobs
      // before the sweep settles them.
      expireBefore: new Date(
        now.getTime() - SPEAKING_GRADING_JOB_POLICY.queueExpiryMs,
      ),
    });
    if (job === undefined) return;

    if (job.environment !== input.environment) {
      if (await this.dependencies.repository.returnToQueue(job.jobId)) {
        await this.dependencies.queue.enqueue({
          jobId: job.jobId,
          environment: job.environment,
        });
      }
      return;
    }

    const permit = await this.dependencies.concurrencyLimiter.acquire({
      organizationId: job.organizationId,
      maxConcurrent: job.maxConcurrent,
      requestId: job.jobId,
      environment: job.environment,
    });
    if (!permit.allowed) {
      if (await this.dependencies.repository.returnToQueue(job.jobId)) {
        await this.dependencies.queue.enqueue({
          jobId: job.jobId,
          environment: job.environment,
          delayMs: SPEAKING_GRADING_JOB_POLICY.permitRetryDelayMs,
        });
      }
      return;
    }

    try {
      await this.processClaimed(job);
    } finally {
      await permit.lease.release().catch(() => undefined);
    }
  }

  private async processClaimed(job: SpeakingGradingJob): Promise<void> {
    const lookup = await this.dependencies.audioRepository.findUpload({
      assetId: job.audioAssetId,
      organizationId: job.organizationId,
      endUserId: job.endUserId,
      environment: job.environment,
    });
    const asset = lookup.kind === 'asset' ? lookup.asset : undefined;
    if (
      asset === undefined ||
      asset.retentionExpiresAt.getTime() <= this.now().getTime()
    ) {
      await this.failBeforeDispatch(job, AUDIO_ASSET_EXPIRED);
      return;
    }

    let audio: SpeakingAudio;
    try {
      audio = await this.dependencies.audioStorage.readObject({
        environment: asset.environment,
        objectKey: asset.objectKey,
        contentType: asset.contentType,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') {
        await this.failBeforeDispatch(job, AUDIO_ASSET_EXPIRED);
        return;
      }
      if (error instanceof AppError && error.code === 'PAYLOAD_TOO_LARGE') {
        await this.failBeforeDispatch(job, jobError(error));
        return;
      }
      throw error;
    }

    const dispatchStartedAt = this.now();
    if (
      !(await this.dependencies.repository.markDispatchStarted(
        job.jobId,
        dispatchStartedAt,
      ))
    ) {
      return;
    }

    await this.dispatch(job, audio, dispatchStartedAt);
  }

  private async failBeforeDispatch(
    job: SpeakingGradingJob,
    error: SpeakingGradingJobError,
  ): Promise<void> {
    const failed = await this.dependencies.repository.fail({
      jobId: job.jobId,
      error,
      completedAt: this.now(),
    });
    if (failed && job.environment === 'sandbox') {
      await this.dependencies.sandboxBudget
        .release(job.jobId)
        .catch(() => undefined);
    }
  }

  private async dispatch(
    job: SpeakingGradingJob,
    audio: SpeakingAudio,
    dispatchStartedAt: Date,
  ): Promise<void> {
    let result: {
      readonly data: SpeakingV2QuestionResult;
      readonly downstreamMs: number;
      readonly usage?: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly totalTokens?: number;
      };
      readonly models?: readonly {
        readonly provider: string;
        readonly name: string;
      }[];
      readonly aiProcessingMs?: number;
    };
    try {
      result = await this.dependencies.orchestrator.execute({
        operation: QUESTION_GRADING,
        input: {
          audio,
          part: job.request.part,
          questionId: job.request.questionId,
          ...(job.request.promptText === undefined
            ? {}
            : { promptText: job.request.promptText }),
          ...(job.request.testType === undefined
            ? {}
            : { testType: job.request.testType }),
          ...(job.request.testCode === undefined
            ? {}
            : { testCode: job.request.testCode }),
          ...(job.request.partResultId === undefined
            ? {}
            : { partResultId: job.request.partResultId }),
        },
        requestId: job.jobId,
        receivedAt: dispatchStartedAt,
        signal: new AbortController().signal,
        organizationId: job.organizationId,
        apiKeyId: job.apiKeyId,
        environment: job.environment,
        userId: job.endUserId,
        identityMode: job.identityMode,
        scopes: ['speaking.grade'],
      });
    } catch (error) {
      const failure = jobError(error);
      await this.finalize(job, dispatchStartedAt, {
        outcome: meteringOutcome(error),
        httpStatus: error instanceof AppError ? error.httpStatus : 500,
        errorCode: failure.code,
        modelCalled: true,
      });
      await this.dependencies.repository.fail({
        jobId: job.jobId,
        error: failure,
        completedAt: this.now(),
      });
      return;
    }

    const owner = {
      organizationId: job.organizationId,
      endUserId: job.endUserId,
      environment: job.environment,
    };
    try {
      await this.dependencies.resultOwnership.record(
        owner,
        'response',
        result.data.meta.response_id,
      );
      if (job.request.partResultId !== undefined) {
        await this.dependencies.resultOwnership.record(
          owner,
          'part',
          job.request.partResultId,
        );
      }
      await this.dependencies.repository.succeed({
        jobId: job.jobId,
        result: result.data,
        completedAt: this.now(),
      });
    } catch (error) {
      const failure = jobError(error);
      await this.dependencies.repository.fail({
        jobId: job.jobId,
        error: failure,
        completedAt: this.now(),
      });
      return;
    }

    await this.finalize(job, dispatchStartedAt, {
      outcome: 'success',
      httpStatus: 200,
      modelCalled: true,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(result.models === undefined ? {} : { models: result.models }),
      downstreamMs: result.downstreamMs,
      ...(result.aiProcessingMs === undefined
        ? {}
        : { aiProcessingMs: result.aiProcessingMs }),
    });
  }

  private async finalize(
    job: SpeakingGradingJob,
    dispatchStartedAt: Date,
    input: {
      readonly outcome:
        | 'success'
        | 'client_error'
        | 'downstream_error'
        | 'internal_error';
      readonly httpStatus: number;
      readonly errorCode?: string;
      readonly modelCalled: boolean;
      readonly usage?: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly totalTokens?: number;
      };
      readonly models?: readonly {
        readonly provider: string;
        readonly name: string;
      }[];
      readonly downstreamMs?: number;
      readonly aiProcessingMs?: number;
    },
  ): Promise<void> {
    await this.dependencies.finalizer
      .finalize({
        requestId: job.jobId,
        organizationId: job.organizationId,
        apiKeyId: job.apiKeyId,
        actorId: job.endUserId,
        operation: QUESTION_GRADING,
        environment: job.environment,
        outcome: input.outcome,
        httpStatus: input.httpStatus,
        ...(input.errorCode === undefined
          ? {}
          : { errorCode: input.errorCode }),
        modelCalled: input.modelCalled,
        quotaTracked: job.quotaTracked,
        ...(job.quotaUnverified ? { quotaUnverified: true } : {}),
        occurredAt: dispatchStartedAt,
        totalMs: Math.max(
          0,
          this.now().getTime() - dispatchStartedAt.getTime(),
        ),
        ...(input.usage === undefined ? {} : { usage: input.usage }),
        ...(input.models === undefined ? {} : { models: input.models }),
        ...(input.downstreamMs === undefined
          ? {}
          : { downstreamMs: input.downstreamMs }),
        ...(input.aiProcessingMs === undefined
          ? {}
          : { aiProcessingMs: input.aiProcessingMs }),
      })
      .catch(() => undefined);
  }
}
