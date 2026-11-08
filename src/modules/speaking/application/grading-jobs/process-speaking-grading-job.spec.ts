import { Blob } from 'node:buffer';
import { readFileSync } from 'node:fs';

import { AppError } from '@/common/errors/app-error';
import type { SpeakingAudio } from '@/contracts/speaking/grading';
import type { SpeakingV2QuestionResult } from '@/contracts/speaking/v2/question-result';
import type { ConcurrencyLimiterPort } from '@/modules/gateway/application/concurrency-limiter.port';
import type { GradingOrchestratorPort } from '@/modules/gateway/application/graded-request/grading-orchestrator.port';
import type { SandboxDispatchBudgetPort } from '@/modules/gateway/public/sandbox-dispatch-budget';
import type {
  MeteringFinalizeInput,
  MeteringFinalizerPort,
} from '@/modules/metering/application/usage-recording/metering-finalizer.port';
import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/speaking-audio-upload.port';
import type { SpeakingV2ResultOwnershipPort } from '@/modules/speaking/application/speaking-v2-result-ownership.port';
import type { SpeakingAudioAsset } from '@/modules/speaking/domain/speaking-audio-asset';
import { ProcessSpeakingGradingJob } from './process-speaking-grading-job';
import type {
  SpeakingGradingJob,
  SpeakingGradingJobError,
} from './speaking-grading-job';
import { SPEAKING_GRADING_JOB_POLICY } from './speaking-grading-job.policy';
import type {
  SpeakingGradingJobQueuePort,
  SpeakingGradingJobRepositoryPort,
} from './speaking-grading-job.port';

const NOW = new Date('2026-11-08T01:00:00.000Z');
const job: SpeakingGradingJob = {
  jobId: 'sgj_01J00000000000000000000001',
  organizationId: 'org_acme',
  endUserId: 'user_acme',
  environment: 'sandbox',
  apiKeyId: 'ak_acme',
  maxConcurrent: 3,
  quotaTracked: true,
  audioAssetId: 'aud_01J00000000000000000000001',
  request: { part: 1, questionId: 'question-1' },
  status: 'queued',
  createdAt: NOW,
};
const questionResult = (
  JSON.parse(
    readFileSync(
      'test/fixtures/ai-speaking/grading-v2-question-post.200.json',
      'utf8',
    ),
  ) as { readonly data: SpeakingV2QuestionResult }
).data;
const asset: SpeakingAudioAsset = {
  assetId: job.audioAssetId,
  organizationId: job.organizationId,
  endUserId: job.endUserId,
  environment: job.environment,
  objectKey: 'orgs/org_acme/speaking/aud_01J00000000000000000000001/original',
  contentType: 'audio/wav',
  byteSize: 1_024,
  acceptedAt: NOW,
  retentionExpiresAt: new Date('2026-12-08T01:00:00.000Z'),
};
const audio: SpeakingAudio = {
  blob: new Blob([Buffer.from('audio bytes')], { type: 'audio/wav' }),
  filename: 'audio.wav',
  contentType: 'audio/wav',
};

function harness(
  options: {
    readonly claimed?: SpeakingGradingJob | null;
    readonly audioAsset?: SpeakingAudioAsset | null;
    readonly readError?: unknown;
    readonly dispatchError?: unknown;
    readonly permit?: 'allowed' | 'denied';
    readonly markDispatchStarted?: boolean;
    readonly advanceClockMs?: number;
  } = {},
) {
  let clock = new Date(NOW);
  const release = jest.fn(async () => undefined);
  const repository = {
    claim: jest.fn(async () =>
      options.claimed === null
        ? undefined
        : (options.claimed ?? { ...job, status: 'running' as const }),
    ),
    returnToQueue: jest.fn(async () => true),
    markDispatchStarted: jest.fn(
      async () => options.markDispatchStarted ?? true,
    ),
    succeed: jest.fn(async () => true),
    fail: jest.fn(async () => true),
  } satisfies Pick<
    SpeakingGradingJobRepositoryPort,
    'claim' | 'returnToQueue' | 'markDispatchStarted' | 'succeed' | 'fail'
  >;
  const queue = {
    enqueue: jest.fn(async () => undefined),
  } satisfies Pick<SpeakingGradingJobQueuePort, 'enqueue'>;
  const audioRepository = {
    findUpload: jest.fn(async () =>
      options.audioAsset === undefined
        ? { kind: 'asset' as const, asset }
        : options.audioAsset === null
          ? { kind: 'missing' as const }
          : { kind: 'asset' as const, asset: options.audioAsset },
    ),
  } satisfies Pick<SpeakingAudioUploadRepositoryPort, 'findUpload'>;
  const audioStorage = {
    readObject: jest.fn(async () => {
      if (options.readError !== undefined) throw options.readError;
      return audio;
    }),
  } satisfies Pick<SpeakingAudioAssetStoragePort, 'readObject'>;
  const concurrencyLimiter = {
    acquire: jest.fn(async () =>
      options.permit === 'denied'
        ? { allowed: false as const, retryAfterMs: 10_000 }
        : { allowed: true as const, lease: { release } },
    ),
  } satisfies ConcurrencyLimiterPort;
  const execute = jest.fn(async () => {
    if (options.dispatchError !== undefined) throw options.dispatchError;
    clock = new Date(clock.getTime() + (options.advanceClockMs ?? 0));
    return {
      operation: 'speaking.v2.question-grading',
      data: questionResult,
      downstreamMs: 123,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      models: [{ provider: 'example', name: 'model' }],
      aiProcessingMs: 100,
    };
  });
  const orchestrator = { execute } as unknown as GradingOrchestratorPort;
  const record = jest.fn(async () => undefined);
  const resultOwnership = { record } satisfies Pick<
    SpeakingV2ResultOwnershipPort,
    'record'
  >;
  const finalize = jest.fn(async (_input: MeteringFinalizeInput) => undefined);
  const finalizer = { finalize } satisfies MeteringFinalizerPort;
  const sandboxRelease = jest.fn(async () => undefined);
  const sandboxBudget = { release: sandboxRelease } satisfies Pick<
    SandboxDispatchBudgetPort,
    'release'
  >;
  const processor = new ProcessSpeakingGradingJob({
    repository,
    queue,
    audioRepository,
    audioStorage,
    concurrencyLimiter,
    orchestrator,
    resultOwnership,
    finalizer,
    sandboxBudget,
    now: () => new Date(clock),
  });
  return {
    processor,
    repository,
    queue,
    audioRepository,
    audioStorage,
    concurrencyLimiter,
    execute,
    record,
    finalize,
    release,
    sandboxRelease,
  };
}

describe('ProcessSpeakingGradingJob', () => {
  it('skips a duplicate delivery when the conditional claim loses', async () => {
    const subject = harness({ claimed: null });

    await subject.processor.execute({
      jobId: job.jobId,
      environment: job.environment,
    });

    expect(subject.concurrencyLimiter.acquire).not.toHaveBeenCalled();
    expect(subject.execute).not.toHaveBeenCalled();
    expect(subject.finalize).not.toHaveBeenCalled();
  });

  it('returns a job to the queue with the policy delay when no permit is available', async () => {
    const subject = harness({ permit: 'denied' });

    await subject.processor.execute({
      jobId: job.jobId,
      environment: job.environment,
    });

    expect(subject.concurrencyLimiter.acquire).toHaveBeenCalledWith({
      organizationId: job.organizationId,
      maxConcurrent: job.maxConcurrent,
      requestId: job.jobId,
      environment: job.environment,
    });
    expect(subject.repository.returnToQueue).toHaveBeenCalledWith(job.jobId);
    expect(subject.queue.enqueue).toHaveBeenCalledWith({
      jobId: job.jobId,
      environment: job.environment,
      delayMs: SPEAKING_GRADING_JOB_POLICY.permitRetryDelayMs,
    });
    expect(subject.audioRepository.findUpload).not.toHaveBeenCalled();
    expect(subject.release).not.toHaveBeenCalled();
  });

  it('fails an expired asset before dispatch and releases its Sandbox reservation and permit', async () => {
    const subject = harness({
      audioAsset: { ...asset, retentionExpiresAt: new Date(NOW.getTime() - 1) },
    });

    await subject.processor.execute({
      jobId: job.jobId,
      environment: job.environment,
    });

    expect(subject.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.jobId,
        error: expect.objectContaining({
          code: 'AUDIO_ASSET_EXPIRED',
        }) as unknown as SpeakingGradingJobError,
      }),
    );
    expect(subject.sandboxRelease).toHaveBeenCalledWith(job.jobId);
    expect(subject.repository.markDispatchStarted).not.toHaveBeenCalled();
    expect(subject.execute).not.toHaveBeenCalled();
    expect(subject.release).toHaveBeenCalledTimes(1);
  });

  it('maps a missing object to AUDIO_ASSET_EXPIRED before dispatch', async () => {
    const subject = harness({
      readError: new AppError({
        code: 'NOT_FOUND',
        message: 'Speaking audio object was not found',
        retryable: false,
      }),
    });

    await subject.processor.execute({
      jobId: job.jobId,
      environment: job.environment,
    });

    expect(subject.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'AUDIO_ASSET_EXPIRED',
        }) as unknown as SpeakingGradingJobError,
      }),
    );
    expect(subject.sandboxRelease).toHaveBeenCalledWith(job.jobId);
    expect(subject.repository.markDispatchStarted).not.toHaveBeenCalled();
    expect(subject.execute).not.toHaveBeenCalled();
    expect(subject.release).toHaveBeenCalledTimes(1);
  });

  it('stores the captured provider result, records ownership and finalizes metering once', async () => {
    const subject = harness({ advanceClockMs: 321 });

    await subject.processor.execute({
      jobId: job.jobId,
      environment: job.environment,
    });

    expect(subject.repository.succeed).toHaveBeenCalledWith({
      jobId: job.jobId,
      result: questionResult,
      completedAt: new Date(NOW.getTime() + 321),
    });
    expect(subject.record).toHaveBeenCalledWith(
      {
        organizationId: job.organizationId,
        endUserId: job.endUserId,
        environment: job.environment,
      },
      'response',
      questionResult.meta.response_id,
    );
    expect(subject.finalize).toHaveBeenCalledTimes(1);
    expect(subject.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: job.jobId,
        organizationId: job.organizationId,
        apiKeyId: job.apiKeyId,
        actorId: job.endUserId,
        operation: 'speaking.v2.question-grading',
        environment: job.environment,
        outcome: 'success',
        quotaTracked: true,
        modelCalled: true,
        totalMs: 321,
      }),
    );
    expect(subject.release).toHaveBeenCalledTimes(1);
  });

  it('stores the synchronous AUDIO_UNREADABLE code and still finalizes the dispatched attempt', async () => {
    const subject = harness({
      dispatchError: new AppError({
        code: 'AUDIO_UNREADABLE',
        message: 'Speaking audio could not be decoded',
        retryable: false,
      }),
    });

    await subject.processor.execute({
      jobId: job.jobId,
      environment: job.environment,
    });

    expect(subject.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.jobId,
        error: expect.objectContaining({
          code: 'AUDIO_UNREADABLE',
          retryable: false,
        }) as unknown as SpeakingGradingJobError,
      }),
    );
    expect(subject.finalize).toHaveBeenCalledTimes(1);
    expect(subject.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'client_error',
        errorCode: 'AUDIO_UNREADABLE',
        modelCalled: true,
      }),
    );
    expect(subject.sandboxRelease).not.toHaveBeenCalled();
    expect(subject.release).toHaveBeenCalledTimes(1);
  });

  it('releases the permit if the dispatch mark no longer wins', async () => {
    const subject = harness({ markDispatchStarted: false });

    await subject.processor.execute({
      jobId: job.jobId,
      environment: job.environment,
    });

    expect(subject.execute).not.toHaveBeenCalled();
    expect(subject.finalize).not.toHaveBeenCalled();
    expect(subject.release).toHaveBeenCalledTimes(1);
  });
});
