import type { SpeakingV2QuestionResult } from '@/contracts/speaking/v2/question-result';
import type { SpeakingV2TestType } from '@/contracts/speaking/v2/response.shared';
import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';

/** Where a Speaking grading job stands (ADR-0158). */
export type SpeakingGradingJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

/**
 * Codes a job may end with beyond the public codes the synchronous v2 question
 * grade already maps (such as `AUDIO_UNREADABLE`). `retryable` says whether the
 * integrator may resubmit; the before/after-dispatch split says whether the
 * provider may have graded and billed it.
 */
export const SPEAKING_GRADING_JOB_ERRORS = {
  /** Interrupted after the AI Service call started; never re-dispatched. */
  DISPATCH_INTERRUPTED: { retryable: true, afterDispatch: true },
  /** Waited in the queue past its deadline; never dispatched. */
  JOB_EXPIRED: { retryable: true, afterDispatch: false },
  /** The Audio asset passed its retention deadline before dispatch. */
  AUDIO_ASSET_EXPIRED: { retryable: false, afterDispatch: false },
} as const;

export interface SpeakingGradingJobError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** The validated question fields, in the synchronous v2 question grade's shape. */
export interface SpeakingGradingJobRequest {
  readonly part: number;
  readonly questionId: string;
  readonly promptText?: string;
  readonly testType?: SpeakingV2TestType;
  readonly testCode?: string;
  readonly partResultId?: string;
}

export interface SpeakingGradingJobOwner {
  readonly organizationId: string;
  readonly endUserId: string;
  readonly environment: SpeakingAudioEnvironment;
}

export interface SpeakingGradingJob extends SpeakingGradingJobOwner {
  readonly jobId: string;
  /** The API key that submitted the job; metering attributes usage to it. */
  readonly apiKeyId: string;
  /**
   * The Organization's Concurrency permit ceiling read at submit, as the
   * synchronous route reads it at authentication.
   * ponytail: snapshot, so a limit change reaches only jobs submitted after it
   * (at most the 15-minute queue window); look it up at claim time if that matters.
   */
  readonly maxConcurrent: number;
  /**
   * Whether submit admission checked a monthly quota for this job
   * (`gradedAdmissionPolicy(...).quotaTracked`); metering evidence carries it
   * as the synchronous route does, so the finalizer increments the counter.
   */
  readonly quotaTracked: boolean;
  readonly audioAssetId: string;
  readonly request: SpeakingGradingJobRequest;
  readonly status: SpeakingGradingJobStatus;
  readonly createdAt: Date;
  readonly leaseExpiresAt?: Date;
  readonly dispatchStartedAt?: Date;
  readonly completedAt?: Date;
  readonly result?: SpeakingV2QuestionResult;
  readonly error?: SpeakingGradingJobError;
}

export type NewSpeakingGradingJob = Omit<
  SpeakingGradingJob,
  | 'status'
  | 'leaseExpiresAt'
  | 'dispatchStartedAt'
  | 'completedAt'
  | 'result'
  | 'error'
>;

const JOB_ID_PATTERN = /^sgj_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A job id is `sgj_` followed by a Crockford-base32 ULID, like `aud_` asset ids. */
export function isSpeakingGradingJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value);
}
