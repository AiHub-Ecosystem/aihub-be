import { AppError } from '@/common/errors/app-error';
import { databaseUnavailableError } from '@/common/postgres/postgres-unavailable-error';
import { IDEMPOTENCY_RETENTION_MS } from '@/modules/idempotency/public/idempotency-key';
import { organizationTransaction } from '@/modules/persistence/persistence.module';
import type {
  NewSpeakingGradingJob,
  SpeakingGradingJob,
  SpeakingGradingJobError,
  SpeakingGradingJobOwner,
} from '@/modules/speaking/application/grading-jobs/speaking-grading-job';
import type {
  SpeakingGradingJobAdmission,
  SpeakingGradingJobAdmissionRelease,
  SpeakingGradingJobCreationOutcome,
  SpeakingGradingJobRepositoryPort,
} from '@/modules/speaking/application/grading-jobs/speaking-grading-job.port';
import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';
import type { Prisma, PrismaClient } from '@prisma-client/client';

import {
  type InFlightCountInput,
  type SpeakingGradingJobRow,
  clearExpiredKeyedJobs,
  countInFlight,
  isKeyUniquenessViolation,
  mapIdEnvironment,
  mapJob,
  requiredJob,
  selectKeyedJob,
} from './speaking-grading-job-row';

import { jobColumns } from './speaking-grading-job-columns';

const SPEAKING_GRADING_QUOTA_LOCK_SQL =
  'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

async function insertJob(
  client: PrismaClient | Prisma.TransactionClient,
  job: NewSpeakingGradingJob,
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO speaking_grading_jobs (job_id, organization_id, end_user_id, environment, api_key_id, quota_tracked, quota_unverified, max_concurrent, audio_asset_id, part, question_id, prompt_text, test_type, test_code, part_result_id, idempotency_key, status, created_at, identity_mode, quota_reservation_active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'queued', $17, $18, $19)`,
    job.jobId,
    job.organizationId,
    job.endUserId,
    job.environment,
    job.apiKeyId,
    job.quotaTracked,
    job.quotaUnverified,
    job.maxConcurrent,
    job.audioAssetId,
    job.request.part,
    job.request.questionId,
    job.request.promptText ?? null,
    job.request.testType ?? null,
    job.request.testCode ?? null,
    job.request.partResultId ?? null,
    job.idempotencyKey ?? null,
    job.createdAt,
    job.identityMode,
    job.quotaTracked,
  );
}

/**
 * Gives back what admission spent outside Postgres, on every path where the
 * job row did not commit (holding order: spend, then commit, then compensate).
 * A failed release is swallowed: the caller must see why it was refused.
 */
async function releaseAdmission(
  release: SpeakingGradingJobAdmissionRelease | undefined,
): Promise<void> {
  try {
    await release?.();
  } catch {
    // A compensation failure cannot replace the reason the submission was refused.
  }
}

function throwStoreUnavailable(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw databaseUnavailableError(
    error,
    'Speaking grading job store is unavailable',
  );
}

export class PostgresSpeakingGradingJobRepository
  implements SpeakingGradingJobRepositoryPort
{
  constructor(private readonly client: PrismaClient) {}

  /** Request-serving access declares its Organization before any statement. */
  private scoped<T>(
    organizationId: string,
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.run(() =>
      organizationTransaction(this.client, organizationId, callback),
    );
  }

  async create(job: NewSpeakingGradingJob): Promise<void> {
    await this.scoped(job.organizationId, (transaction) =>
      insertJob(transaction, job),
    );
  }

  async createWithAdmission(input: {
    readonly job: NewSpeakingGradingJob;
    readonly monthlyQuota: number | null;
    readonly admit: (
      monthlyQuota: number | null,
    ) => Promise<SpeakingGradingJobAdmission>;
  }): Promise<SpeakingGradingJobCreationOutcome> {
    const unexpiredSince = new Date(
      input.job.createdAt.getTime() - IDEMPOTENCY_RETENTION_MS,
    );
    if (input.job.idempotencyKey !== undefined) {
      const idempotencyKey = input.job.idempotencyKey;
      const keyed = {
        organizationId: input.job.organizationId,
        endUserId: input.job.endUserId,
        idempotencyKey,
      };
      const existing = await this.scoped(keyed.organizationId, (transaction) =>
        selectKeyedJob(transaction, { ...keyed, unexpiredSince }),
      );
      if (existing !== undefined) {
        return { created: false, existingJobId: existing.jobId };
      }
      await this.scoped(keyed.organizationId, (transaction) =>
        clearExpiredKeyedJobs(transaction, {
          ...keyed,
          expiredBefore: unexpiredSince,
        }),
      );
    }

    if (input.monthlyQuota === null) {
      const admission = await input.admit(null);
      if (!admission.admitted) {
        return { created: false, existingJobId: input.job.jobId };
      }
      try {
        await this.create(input.job);
      } catch (error) {
        // The row did not commit, so what admission spent is given back.
        await releaseAdmission(admission.release);
        if (!isKeyUniquenessViolation(error)) throw error;
        return this.recoverKeyedJob(error, input.job, unexpiredSince);
      }
      return { created: true };
    }

    const monthlyQuota = input.monthlyQuota;
    let admissionFailed = false;
    let admissionError: unknown;
    // Held outside the callback: the transaction deadline can reject the
    // transaction while the callback is still running, so compensation has to
    // work from either side and run at most once.
    let admissionRelease: SpeakingGradingJobAdmissionRelease | undefined;
    const compensate = async (): Promise<void> => {
      const release = admissionRelease;
      admissionRelease = undefined;
      await releaseAdmission(release);
    };
    try {
      return await organizationTransaction(
        this.client,
        input.job.organizationId,
        async (transaction): Promise<SpeakingGradingJobCreationOutcome> => {
          // One lock per Organization, not per month: reservations carry over a
          // month boundary, so admissions on either side must serialize.
          await transaction.$executeRawUnsafe(
            SPEAKING_GRADING_QUOTA_LOCK_SQL,
            `speaking-grading-quota:${input.job.organizationId}`,
          );
          const inFlight = await countInFlight(transaction, {
            organizationId: input.job.organizationId,
            environment: input.job.environment,
          });
          let admission: SpeakingGradingJobAdmission;
          try {
            admission = await input.admit(Math.max(0, monthlyQuota - inFlight));
          } catch (error) {
            admissionFailed = true;
            admissionError = error;
            throw error;
          }
          if (!admission.admitted) {
            return { created: false, existingJobId: input.job.jobId };
          }
          admissionRelease = admission.release;
          try {
            await insertJob(transaction, input.job);
          } catch (error) {
            // A closed transaction surfaces here, after this callback has
            // already spent; the outer catch may have run before the spend.
            await compensate();
            throw error;
          }
          return { created: true };
        },
      );
    } catch (error) {
      // Any throw from here means the row did not commit, including a commit
      // that failed after the callback returned (transaction timeout).
      await compensate();
      if (admissionFailed) throw admissionError;
      if (!isKeyUniquenessViolation(error)) throwStoreUnavailable(error);
      return this.recoverKeyedJob(error, input.job, unexpiredSince);
    }
  }

  /** Returns the job a concurrent submission with the same key committed. */
  private async recoverKeyedJob(
    error: unknown,
    job: NewSpeakingGradingJob,
    unexpiredSince: Date,
  ): Promise<SpeakingGradingJobCreationOutcome> {
    const idempotencyKey = job.idempotencyKey;
    const existing =
      idempotencyKey === undefined
        ? undefined
        : await this.scoped(job.organizationId, (transaction) =>
            selectKeyedJob(transaction, {
              organizationId: job.organizationId,
              endUserId: job.endUserId,
              idempotencyKey,
              unexpiredSince,
            }),
          );
    if (existing !== undefined) {
      return { created: false, existingJobId: existing.jobId };
    }
    throwStoreUnavailable(error);
  }

  async findOwned(
    owner: SpeakingGradingJobOwner,
    jobId: string,
  ): Promise<SpeakingGradingJob | undefined> {
    return this.scoped(owner.organizationId, async (transaction) => {
      const rows = await transaction.$queryRawUnsafe<
        readonly SpeakingGradingJobRow[]
      >(
        `SELECT ${jobColumns()} FROM speaking_grading_jobs WHERE job_id = $1 AND organization_id = $2 AND end_user_id = $3 AND environment = $4`,
        jobId,
        owner.organizationId,
        owner.endUserId,
        owner.environment,
      );
      return mapJob(rows[0]);
    });
  }

  async eraseByEndUser(input: {
    readonly organizationId: string;
    readonly endUserId: string;
  }): Promise<number> {
    return this.scoped(input.organizationId, (transaction) =>
      transaction.$executeRawUnsafe(
        'DELETE FROM speaking_grading_jobs WHERE organization_id = $1 AND end_user_id = $2',
        input.organizationId,
        input.endUserId,
      ),
    );
  }

  async findByIdempotencyKey(input: {
    readonly organizationId: string;
    readonly endUserId: string;
    readonly idempotencyKey: string;
  }): Promise<SpeakingGradingJob | undefined> {
    return this.scoped(input.organizationId, (transaction) =>
      selectKeyedJob(transaction, input),
    );
  }

  async claim(input: {
    readonly jobId: string;
    readonly now: Date;
    readonly leaseExpiresAt: Date;
    readonly expireBefore: Date;
  }): Promise<SpeakingGradingJob | undefined> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly SpeakingGradingJobRow[]
      >(
        `UPDATE speaking_grading_jobs SET status = 'running', lease_expires_at = $2 WHERE job_id = $1 AND status = 'queued' AND created_at >= $3 RETURNING ${jobColumns()}`,
        input.jobId,
        input.leaseExpiresAt,
        input.expireBefore,
      );
      return mapJob(rows[0]);
    });
  }

  async returnToQueue(jobId: string): Promise<boolean> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly { readonly jobId: string }[]
      >(
        `UPDATE speaking_grading_jobs SET status = 'queued', lease_expires_at = NULL WHERE job_id = $1 AND status = 'running' AND dispatch_started_at IS NULL RETURNING job_id AS "jobId"`,
        jobId,
      );
      return rows.length === 1;
    });
  }

  async markDispatchStarted(jobId: string, now: Date): Promise<boolean> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly { readonly jobId: string }[]
      >(
        `UPDATE speaking_grading_jobs SET dispatch_started_at = $2 WHERE job_id = $1 AND status = 'running' AND dispatch_started_at IS NULL RETURNING job_id AS "jobId"`,
        jobId,
        now,
      );
      return rows.length === 1;
    });
  }

  async succeed(input: {
    readonly jobId: string;
    readonly result: SpeakingGradingJob['result'];
    readonly completedAt: Date;
  }): Promise<boolean> {
    if (input.result === undefined) return false;
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly { readonly jobId: string }[]
      >(
        `UPDATE speaking_grading_jobs SET status = 'succeeded', result = $2::jsonb, completed_at = $3, lease_expires_at = NULL WHERE job_id = $1 AND status = 'running' RETURNING job_id AS "jobId"`,
        input.jobId,
        JSON.stringify(input.result),
        input.completedAt,
      );
      return rows.length === 1;
    });
  }

  async releaseQuotaReservation(jobId: string): Promise<boolean> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly { readonly jobId: string }[]
      >(
        `UPDATE speaking_grading_jobs SET quota_reservation_active = false WHERE job_id = $1 AND status = 'succeeded' AND quota_reservation_active = true RETURNING job_id AS "jobId"`,
        jobId,
      );
      return rows.length === 1;
    });
  }

  async fail(input: {
    readonly jobId: string;
    readonly error: SpeakingGradingJobError;
    readonly completedAt: Date;
  }): Promise<boolean> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly { readonly jobId: string }[]
      >(
        `UPDATE speaking_grading_jobs SET status = 'failed', result = NULL, quota_reservation_active = false, completed_at = $2, lease_expires_at = NULL, error_code = $3, error_message = $4, error_retryable = $5 WHERE job_id = $1 AND status IN ('queued', 'running') RETURNING job_id AS "jobId"`,
        input.jobId,
        input.completedAt,
        input.error.code,
        input.error.message,
        input.error.retryable,
      );
      return rows.length === 1;
    });
  }

  async countInFlight(input: InFlightCountInput): Promise<number> {
    return this.scoped(input.organizationId, (transaction) =>
      countInFlight(transaction, input),
    );
  }

  async listStaleQueued(input: {
    readonly createdBefore: Date;
    readonly limit: number;
  }): Promise<
    readonly {
      readonly jobId: string;
      readonly environment: SpeakingAudioEnvironment;
    }[]
  > {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly { readonly jobId: string; readonly environment: string }[]
      >(
        `SELECT job_id AS "jobId", environment FROM speaking_grading_jobs WHERE status = 'queued' AND created_at < $1 ORDER BY created_at ASC LIMIT $2`,
        input.createdBefore,
        input.limit,
      );
      return rows.map(mapIdEnvironment);
    });
  }

  async releaseExpiredLeases(now: Date): Promise<
    readonly {
      readonly jobId: string;
      readonly environment: SpeakingAudioEnvironment;
    }[]
  > {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly { readonly jobId: string; readonly environment: string }[]
      >(
        `UPDATE speaking_grading_jobs SET status = 'queued', lease_expires_at = NULL WHERE status = 'running' AND dispatch_started_at IS NULL AND lease_expires_at <= $1 RETURNING job_id AS "jobId", environment`,
        now,
      );
      return rows.map(mapIdEnvironment);
    });
  }

  async interruptStaleDispatches(input: {
    readonly startedBefore: Date;
    readonly error: SpeakingGradingJobError;
    readonly completedAt: Date;
  }): Promise<readonly SpeakingGradingJob[]> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly SpeakingGradingJobRow[]
      >(
        `UPDATE speaking_grading_jobs SET status = 'failed', result = NULL, quota_reservation_active = false, completed_at = $2, lease_expires_at = NULL, error_code = $3, error_message = $4, error_retryable = $5 WHERE status = 'running' AND dispatch_started_at < $1 RETURNING ${jobColumns()}`,
        input.startedBefore,
        input.completedAt,
        input.error.code,
        input.error.message,
        input.error.retryable,
      );
      return rows.map(requiredJob);
    });
  }

  async expireQueued(input: {
    readonly createdBefore: Date;
    readonly error: SpeakingGradingJobError;
    readonly completedAt: Date;
  }): Promise<readonly SpeakingGradingJob[]> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly SpeakingGradingJobRow[]
      >(
        `UPDATE speaking_grading_jobs SET status = 'failed', result = NULL, quota_reservation_active = false, completed_at = $2, lease_expires_at = NULL, error_code = $3, error_message = $4, error_retryable = $5 WHERE status = 'queued' AND created_at < $1 RETURNING ${jobColumns()}`,
        input.createdBefore,
        input.completedAt,
        input.error.code,
        input.error.message,
        input.error.retryable,
      );
      return rows.map(requiredJob);
    });
  }

  async releaseSettledQuotaReservations(
    completedBefore: Date,
  ): Promise<number> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly { readonly jobId: string }[]
      >(
        `UPDATE speaking_grading_jobs SET quota_reservation_active = false WHERE status = 'succeeded' AND quota_reservation_active = true AND completed_at < $1 RETURNING job_id AS "jobId"`,
        completedBefore,
      );
      return rows.length;
    });
  }

  async deleteCreatedBefore(createdBefore: Date): Promise<number> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly { readonly jobId: string }[]
      >(
        `DELETE FROM speaking_grading_jobs WHERE created_at < $1 RETURNING job_id AS "jobId"`,
        createdBefore,
      );
      return rows.length;
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throwStoreUnavailable(error);
    }
  }
}
