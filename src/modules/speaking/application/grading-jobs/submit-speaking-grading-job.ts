import { Value } from '@sinclair/typebox/value';
import { ulid } from 'ulid';

import { AppError, internalError } from '@/common/errors/app-error';
import { recordRejected } from '@/common/observability/rejected-metric';
import type { RequestContext } from '@/common/request-context/request-context';
import {
  type SpeakingGradingJobAcceptedData,
  SpeakingGradingJobAcceptedDataSchema,
  type SpeakingGradingJobSubmitRequest,
} from '@/contracts/speaking/v2/grading-job';
import { type GradedAdmissionPort } from '@/modules/gateway/application/graded-admission.port';
import {
  type AdmitGradedRequestInput,
  admitGradedRequest,
  gradedAdmissionPolicy,
  gradedAdmissionRefusal,
} from '@/modules/gateway/public/graded-pipeline';
import { quotaPeriod } from '@/modules/gateway/public/quota-period';
import { type SandboxDispatchBudgetPort } from '@/modules/gateway/public/sandbox-dispatch-budget';
import { type IdempotencyServicePort } from '@/modules/idempotency/application/idempotency-service.port';
import {
  SPEAKING_GRADING_JOB_CREATE_OPERATION,
  resolveIdempotencyKey,
} from '@/modules/idempotency/public/idempotency-operation';
import type { AuthenticatedApiKey } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type {
  SpeakingAudioUploadOwner,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/speaking-audio-upload.port';
import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';
import {
  type NewSpeakingGradingJob,
  type SpeakingGradingJobOwner,
  type SpeakingGradingJobRequest,
} from './speaking-grading-job';
import type {
  SpeakingGradingJobQueuePort,
  SpeakingGradingJobRepositoryPort,
} from './speaking-grading-job.port';

export interface SubmitSpeakingGradingJobInput {
  readonly context: RequestContext;
  readonly authenticated: AuthenticatedApiKey;
  readonly request: SpeakingGradingJobSubmitRequest;
  readonly idempotencyKey?: string | readonly string[];
}

function notFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: 'Speaking audio asset not found',
    retryable: false,
  });
}

function speakingEnvironment(
  value: string | undefined,
): SpeakingAudioEnvironment {
  return value === 'sandbox' ? 'sandbox' : 'production';
}

function ownerFromContext(context: RequestContext): SpeakingGradingJobOwner {
  if (
    context.organizationId === undefined ||
    context.userId === undefined ||
    context.apiKeyId === undefined
  ) {
    throw internalError('Speaking grading job identity is unavailable');
  }
  return {
    organizationId: context.organizationId,
    endUserId: context.userId,
    environment: speakingEnvironment(context.environment),
  };
}

function questionRequest(
  request: SpeakingGradingJobSubmitRequest,
): SpeakingGradingJobRequest {
  return {
    part: request.part,
    questionId: request.question_id,
    ...(request.prompt_text === undefined
      ? {}
      : { promptText: request.prompt_text }),
    ...(request.test_type === undefined ? {} : { testType: request.test_type }),
    ...(request.test_code === undefined ? {} : { testCode: request.test_code }),
    ...(request.part_result_id === undefined
      ? {}
      : { partResultId: request.part_result_id }),
  };
}

export class SubmitSpeakingGradingJob {
  constructor(
    private readonly repository: SpeakingGradingJobRepositoryPort,
    private readonly queue: SpeakingGradingJobQueuePort,
    private readonly audio: SpeakingAudioUploadRepositoryPort,
    private readonly admission: GradedAdmissionPort,
    private readonly sandboxBudget: SandboxDispatchBudgetPort,
    private readonly idempotency: IdempotencyServicePort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    input: SubmitSpeakingGradingJobInput,
  ): Promise<SpeakingGradingJobAcceptedData> {
    const { context, authenticated, request } = input;
    const owner = ownerFromContext(context);
    const identityMode = context.identityMode;
    if (identityMode === undefined) {
      throw internalError('Speaking grading job identity mode is unavailable');
    }
    if (
      owner.organizationId !== authenticated.organizationId ||
      context.apiKeyId !== authenticated.apiKeyId
    ) {
      throw internalError('Speaking grading job identity is inconsistent');
    }
    const idempotencyKey = resolveIdempotencyKey(
      SPEAKING_GRADING_JOB_CREATE_OPERATION,
      input.idempotencyKey,
    );
    const admissionInput: AdmitGradedRequestInput = {
      apiKeyId: authenticated.apiKeyId,
      rateLimitRpm: authenticated.rateLimitRpm,
      organizationId: owner.organizationId,
      requestId: context.requestId,
      operation: 'speaking.v2.question-grading',
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      environment: owner.environment,
      monthlyRequestQuota: authenticated.monthlyRequestQuota,
      hardStopOnQuota: authenticated.hardStopOnQuota,
    };
    const { result } =
      await this.idempotency.execute<SpeakingGradingJobAcceptedData>(
        {
          organizationId: owner.organizationId,
          operation: SPEAKING_GRADING_JOB_CREATE_OPERATION,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          actorId: owner.endUserId,
          requestBody: request,
          requestId: context.requestId,
          timeoutMs: context.operationTimeoutMs,
          responseStatus: 202,
          signal: context.signal,
          deadlineAt: context.deadlineAt,
          beforeDuplicate: async () => {
            await this.admitRepeat(admissionInput, owner.organizationId);
          },
        },
        () =>
          this.submit(
            owner,
            authenticated,
            request,
            admissionInput,
            identityMode,
          ),
        (value) => Value.Parse(SpeakingGradingJobAcceptedDataSchema, value),
      );
    return result;
  }

  /**
   * Applies rate-limit and retry-budget admission without the monthly quota:
   * a replay or an asset probe never grades, so it must not consume quota,
   * but it still answers through the same rate limit as first attempts.
   */
  private async admitRepeat(
    admissionInput: AdmitGradedRequestInput,
    organizationId: string,
  ): Promise<void> {
    const decision = await admitGradedRequest(this.admission, {
      ...admissionInput,
      monthlyRequestQuota: null,
    });
    if (decision.stage === 'rate_limit') recordRejected('rate_limit');
    if (decision.stage !== 'admitted') {
      throw gradedAdmissionRefusal(decision, organizationId, this.now);
    }
  }

  private async submit(
    owner: SpeakingGradingJobOwner,
    authenticated: AuthenticatedApiKey,
    request: SpeakingGradingJobSubmitRequest,
    admissionInput: AdmitGradedRequestInput,
    identityMode: NonNullable<RequestContext['identityMode']>,
  ): Promise<SpeakingGradingJobAcceptedData> {
    const now = this.now();
    const assetOwner: SpeakingAudioUploadOwner = {
      ...owner,
      assetId: request.audio_asset_id,
    };
    const found = await this.audio.findUpload(assetOwner);
    if (
      found.kind !== 'asset' ||
      found.asset.retentionExpiresAt.getTime() <= now.getTime()
    ) {
      // The probe consumed no admission yet: charge the rate limit and the
      // Organization retry budget before answering NOT_FOUND, or a caller
      // could poll for foreign asset ids without ever being limited.
      await this.admitRepeat(admissionInput, owner.organizationId);
      throw notFound();
    }

    const environment = owner.environment;
    const quota = authenticated.monthlyRequestQuota;
    const quotaTracked = gradedAdmissionPolicy(admissionInput).quotaTracked;
    const jobId = `sgj_${ulid()}`;
    // Admission runs inside the repository transaction after this object is
    // captured, so the flag reaches the insert through a getter.
    let quotaUnverified = false;
    const job: NewSpeakingGradingJob = {
      jobId,
      organizationId: owner.organizationId,
      endUserId: owner.endUserId,
      environment,
      identityMode,
      apiKeyId: authenticated.apiKeyId,
      maxConcurrent: authenticated.maxConcurrent,
      quotaTracked,
      get quotaUnverified() {
        return quotaUnverified;
      },
      audioAssetId: request.audio_asset_id,
      request: questionRequest(request),
      createdAt: now,
    };
    let decision: Awaited<ReturnType<typeof admitGradedRequest>> | undefined;
    let sandboxReserved = false;
    try {
      const created = await this.repository.createWithAdmission({
        job,
        since: quotaPeriod(now).start,
        monthlyQuota: environment === 'sandbox' ? null : quota,
        admit: async (monthlyRequestQuota) => {
          const admissionDecision = await admitGradedRequest(this.admission, {
            ...admissionInput,
            monthlyRequestQuota,
          });
          decision = admissionDecision;
          if (admissionDecision.stage !== 'admitted') {
            if (admissionDecision.stage === 'rate_limit') {
              recordRejected('rate_limit');
            }
            if (admissionDecision.stage === 'quota') recordRejected('quota');
            return false;
          }
          quotaUnverified = admissionDecision.quotaUnverified === true;

          if (environment === 'sandbox') {
            let admitted: boolean;
            try {
              admitted = await this.sandboxBudget.reserve({
                organizationId: owner.organizationId,
                requestId: jobId,
              });
            } catch (cause) {
              throw new AppError({
                code: 'INTERNAL_ERROR',
                message: 'Sandbox dispatch admission is unavailable',
                retryable: true,
                cause,
              });
            }
            if (!admitted) {
              recordRejected('quota');
              decision = { stage: 'quota', quota: 0 };
              return false;
            }
            sandboxReserved = true;
          }
          return true;
        },
      });
      if (!created) {
        if (decision === undefined || decision.stage === 'admitted') {
          throw internalError('Speaking grading job admission is unavailable');
        }
        throw gradedAdmissionRefusal(decision, owner.organizationId, this.now);
      }
    } catch (error) {
      if (sandboxReserved) {
        await this.sandboxBudget.release(jobId).catch(() => undefined);
      }
      throw error;
    }
    await this.queue.enqueue({ jobId, environment }).catch(() => undefined);
    return { job_id: jobId, status: 'queued' };
  }
}
