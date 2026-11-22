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
export type SpeakingGradingJobCreationOutcome =
  | { created: true }
  | { created: false; existingJobId: string };

/**
 * What admission spent outside Postgres, and gives back if the job row never
 * commits. `release` must never throw: a compensation failure cannot replace
 * the reason the submission was refused.
 */
export type SpeakingGradingJobAdmissionRelease = () => Promise<void>;

/** What one admission attempt decided, and what it spent if it admitted. */
export type SpeakingGradingJobAdmission =
  | { readonly admitted: false }
  | {
      readonly admitted: true;
      readonly release?: SpeakingGradingJobAdmissionRelease;
    };

export interface SpeakingGradingJobRepositoryPort {
  /** Commits a new job as `queued`. */
  create(job: NewSpeakingGradingJob): Promise<void>;

  /**
   * Serializes quota check, graded admission, key recovery and job creation for
   * one Organization. Admission returns its own compensation, which this method
   * runs whenever the job row does not commit: a refusal, a unique-violation
   * recovery, or a rollback the driver reports.
   *
   * Ordering: spend, then commit, then compensate on abort (#1992). The chosen
   * alternative — commit first and spend afterwards — cannot hold the monthly
   * quota for work that is not accepted yet, because a concurrent submit would
   * read a quota that no row reserves. The cost is a process that dies between
   * the spend and the commit: the job row never exists, so no sweep can find it
   * and the Sandbox reservation stays consumed until #851 reclaims reservations
   * that never dispatched. A crash there loses at most one dispatch unit for the
   * month; a rollback, which is the case this contract makes recoverable, loses
   * none. The monthly quota counter is not among those spends: submit only reads
   * it, and the counter is incremented at metering, after the job completes.
   */
  createWithAdmission(input: {
    readonly job: NewSpeakingGradingJob;
    readonly monthlyQuota: number | null;
    readonly admit: (
      monthlyQuota: number | null,
    ) => Promise<SpeakingGradingJobAdmission>;
  }): Promise<SpeakingGradingJobCreationOutcome>;

  /** The non-terminal job whichever holds this idempotency key, if any. */
  findByIdempotencyKey(input: {
    readonly organizationId: string;
    readonly endUserId: string;
    readonly idempotencyKey: string;
  }): Promise<SpeakingGradingJob | undefined>;

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

  /** `running` -> `succeeded` with the result; quota reservation remains active. */
  succeed(input: {
    readonly jobId: string;
    readonly result: SpeakingV2QuestionResult;
    readonly completedAt: Date;
  }): Promise<boolean>;

  /** Releases successful job's monthly-quota reservation after metering handoff. */
  releaseQuotaReservation(jobId: string): Promise<boolean>;

  /** Any non-terminal state -> `failed` with the error. */
  fail(input: {
    readonly jobId: string;
    readonly error: SpeakingGradingJobError;
    readonly completedAt: Date;
  }): Promise<boolean>;

  /** Active quota reservations (`queued`, `running`, or `succeeded` awaiting metering handoff) for the Organization and Environment, whatever month they were created in. */
  countInFlight(input: {
    readonly organizationId: string;
    readonly environment: SpeakingAudioEnvironment;
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

  /** `succeeded` jobs completed before `completedBefore` that still hold a quota reservation (metering handoff never released it) -> reservation released; returns how many. */
  releaseSettledQuotaReservations(completedBefore: Date): Promise<number>;

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
