import type { SpeakingV2QuestionResult } from '@/contracts/speaking/v2/question-result';
import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';

import type {
  NewSpeakingGradingJob,
  SpeakingGradingJob,
  SpeakingGradingJobError,
  SpeakingGradingJobOwner,
} from './speaking-grading-job';

/**
 * Durable job state in Postgres, the source of truth (ADR-0159). Every state
 * change is conditional on the current state so two workers, or two deployment
 * slots running the sweep, can never both win. A method that reports `false`,
 * `undefined` or an empty list changed nothing.
 */
export interface SpeakingGradingJobRepositoryPort {
  /** Commits a new job as `queued`. */
  create(job: NewSpeakingGradingJob): Promise<void>;

  /** Serializes quota check, graded admission and job creation for one Organization-month. */
  createWithAdmission(input: {
    readonly job: NewSpeakingGradingJob;
    readonly since: Date;
    readonly monthlyQuota: number | null;
    readonly admit: (monthlyQuota: number | null) => Promise<boolean>;
  }): Promise<boolean>;

  /** The job only when it belongs to this Organization, End-User ID and Environment. */
  findOwned(
    owner: SpeakingGradingJobOwner,
    jobId: string,
  ): Promise<SpeakingGradingJob | undefined>;

  /**
   * `queued` -> `running` with a lease; `undefined` when another worker owns it,
   * it is terminal, or it was created before `expireBefore`: a job past its
   * queue deadline is never claimed, so an outage cannot dispatch it before the
   * sweep settles it as `JOB_EXPIRED`.
   */
  claim(input: {
    readonly jobId: string;
    readonly now: Date;
    readonly leaseExpiresAt: Date;
    readonly expireBefore: Date;
  }): Promise<SpeakingGradingJob | undefined>;

  /** `running` without a dispatch mark -> `queued`, for a worker that must wait (no Concurrency permit). */
  returnToQueue(jobId: string): Promise<boolean>;

  /** Records that the AI Service call is about to start; only on a `running` job not yet marked. */
  markDispatchStarted(jobId: string, now: Date): Promise<boolean>;

  /** `running` -> `succeeded` with the result. */
  succeed(input: {
    readonly jobId: string;
    readonly result: SpeakingV2QuestionResult;
    readonly completedAt: Date;
  }): Promise<boolean>;

  /** Any non-terminal state -> `failed` with the error. */
  fail(input: {
    readonly jobId: string;
    readonly error: SpeakingGradingJobError;
    readonly completedAt: Date;
  }): Promise<boolean>;

  /** Jobs `queued` or `running` for the Organization and Environment created at or after `since`. */
  countInFlight(input: {
    readonly organizationId: string;
    readonly environment: SpeakingAudioEnvironment;
    readonly since: Date;
  }): Promise<number>;

  // Sweep steps (ADR-0159 decision 6). Each is one conditional statement.

  /** Ids of jobs still `queued` that were created before `createdBefore`, oldest first. */
  listStaleQueued(input: {
    readonly createdBefore: Date;
    readonly limit: number;
  }): Promise<
    readonly { jobId: string; environment: SpeakingAudioEnvironment }[]
  >;

  /** `running` jobs with no dispatch mark and an expired lease -> `queued`; returns their ids. */
  releaseExpiredLeases(
    now: Date,
  ): Promise<
    readonly { jobId: string; environment: SpeakingAudioEnvironment }[]
  >;

  /** `running` jobs whose dispatch started before `startedBefore` -> `failed` with `error`. */
  interruptStaleDispatches(input: {
    readonly startedBefore: Date;
    readonly error: SpeakingGradingJobError;
    readonly completedAt: Date;
  }): Promise<readonly SpeakingGradingJob[]>;

  /** `queued` jobs created before `createdBefore` -> `failed` with `error`; returned so Sandbox reservations can be released. */
  expireQueued(input: {
    readonly createdBefore: Date;
    readonly error: SpeakingGradingJobError;
    readonly completedAt: Date;
  }): Promise<readonly SpeakingGradingJob[]>;

  /** Deletes jobs created before `createdBefore`; returns how many. */
  deleteCreatedBefore(createdBefore: Date): Promise<number>;
}

/**
 * The BullMQ execution queue: a wake-up signal carrying only the job id. The
 * adapter sets BullMQ's job id to `jobId`, one attempt, no stalled re-runs, and
 * removal on completion and failure, so a later enqueue of the same id is
 * accepted. Production and Sandbox use separate queues.
 */
export interface SpeakingGradingJobQueuePort {
  enqueue(input: {
    readonly jobId: string;
    readonly environment: SpeakingAudioEnvironment;
    readonly delayMs?: number;
  }): Promise<void>;
}

export const SPEAKING_GRADING_JOB_REPOSITORY = Symbol(
  'SPEAKING_GRADING_JOB_REPOSITORY',
);
export const SPEAKING_GRADING_JOB_QUEUE = Symbol('SPEAKING_GRADING_JOB_QUEUE');
