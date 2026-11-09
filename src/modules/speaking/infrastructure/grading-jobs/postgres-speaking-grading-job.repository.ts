import { AppError } from '@/common/errors/app-error';
import { databaseUnavailableError } from '@/common/postgres/postgres-unavailable-error';
import { IDEMPOTENCY_RETENTION_MS } from '@/modules/idempotency/public/idempotency-key';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import type {
  NewSpeakingGradingJob,
  SpeakingGradingJob,
  SpeakingGradingJobError,
  SpeakingGradingJobOwner,
} from '@/modules/speaking/application/grading-jobs/speaking-grading-job';
import type {
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

const JOB_COLUMNS = `
  job_id AS "jobId",
  organization_id AS "organizationId",
  end_user_id AS "endUserId",
  environment,
  identity_mode AS "identityMode",
  api_key_id AS "apiKeyId",
  max_concurrent AS "maxConcurrent",
  quota_tracked AS "quotaTracked",
  quota_unverified AS "quotaUnverified",
  audio_asset_id AS "audioAssetId",
  part,
  question_id AS "questionId",
  prompt_text AS "promptText",
  test_type AS "testType",
  test_code AS "testCode",
  part_result_id AS "partResultId",
  idempotency_key AS "idempotencyKey",
  status,
  lease_expires_at AS "leaseExpiresAt",
  dispatch_started_at AS "dispatchStartedAt",
  result,
  error_code AS "errorCode",
  error_message AS "errorMessage",
  error_retryable AS "errorRetryable",
  created_at AS "createdAt",
  completed_at AS "completedAt"`;

const SPEAKING_GRADING_QUOTA_LOCK_SQL =
  'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

async function insertJob(
  client: PrismaClient | Prisma.TransactionClient,
  job: NewSpeakingGradingJob,
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO speaking_grading_jobs (job_id, organization_id, end_user_id, environment, api_key_id, quota_tracked, quota_unverified, max_concurrent, audio_asset_id, part, question_id, prompt_text, test_type, test_code, part_result_id, idempotency_key, status, created_at, identity_mode) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'queued', $17, $18)`,
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
  );
}

export class PostgresSpeakingGradingJobRepository
  implements SpeakingGradingJobRepositoryPort
{
  constructor(private readonly client: PrismaClient) {}

  async create(job: NewSpeakingGradingJob): Promise<void> {
    await this.run(() => insertJob(this.client, job));
  }

  async createWithAdmission(input: {
    readonly job: NewSpeakingGradingJob;
    readonly since: Date;
    readonly monthlyQuota: number | null;
    readonly admit: (monthlyQuota: number | null) => Promise<boolean>;
  }): Promise<SpeakingGradingJobCreationOutcome> {
    const unexpiredSince = new Date(
      input.job.createdAt.getTime() - IDEMPOTENCY_RETENTION_MS,
    );
    if (input.job.idempotencyKey !== undefined) {
      const existing = await selectKeyedJob(this.client, {
        organizationId: input.job.organizationId,
        endUserId: input.job.endUserId,
        idempotencyKey: input.job.idempotencyKey,
        unexpiredSince,
      });
      if (existing !== undefined) {
        return { created: false, existingJobId: existing.jobId };
      }
      await clearExpiredKeyedJobs(this.client, {
        organizationId: input.job.organizationId,
        endUserId: input.job.endUserId,
        idempotencyKey: input.job.idempotencyKey,
        expiredBefore: unexpiredSince,
      });
    }

    if (input.monthlyQuota === null) {
      const admitted = await input.admit(null);
      if (!admitted) {
        return { created: false, existingJobId: input.job.jobId };
      }
      await this.create(input.job);
      return { created: true };
    }

    const monthlyQuota = input.monthlyQuota;
    let admissionFailed = false;
    let admissionError: unknown;
    try {
      return await this.client.$transaction(
        async (transaction): Promise<SpeakingGradingJobCreationOutcome> => {
          await transaction.$executeRawUnsafe(
            SPEAKING_GRADING_QUOTA_LOCK_SQL,
            `speaking-grading-quota:${input.job.organizationId}:${input.since.toISOString().slice(0, 7)}`,
          );
          const inFlight = await countInFlight(transaction, {
            organizationId: input.job.organizationId,
            environment: input.job.environment,
            since: input.since,
          });
          let admitted: boolean;
          try {
            admitted = await input.admit(Math.max(0, monthlyQuota - inFlight));
          } catch (error) {
            admissionFailed = true;
            admissionError = error;
            throw error;
          }
          if (!admitted) {
            return { created: false, existingJobId: input.job.jobId };
          }
          await insertJob(transaction, input.job);
          return { created: true };
        },
        CONTROL_PLANE_TRANSACTION_OPTIONS,
      );
    } catch (error) {
      if (admissionFailed) throw admissionError;
      if (!isKeyUniquenessViolation(error)) {
        if (error instanceof AppError) throw error;
        throw databaseUnavailableError(
          error,
          'Speaking grading job store is unavailable',
        );
      }
      const existingAfter =
        input.job.idempotencyKey === undefined
          ? undefined
          : await selectKeyedJob(this.client, {
              organizationId: input.job.organizationId,
              endUserId: input.job.endUserId,
              idempotencyKey: input.job.idempotencyKey,
              unexpiredSince,
            });
      if (existingAfter === undefined) {
        if (error instanceof AppError) throw error;
        throw databaseUnavailableError(
          error,
          'Speaking grading job store is unavailable',
        );
      }
      return { created: false, existingJobId: existingAfter.jobId };
    }
  }

  async findOwned(
    owner: SpeakingGradingJobOwner,
    jobId: string,
  ): Promise<SpeakingGradingJob | undefined> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly SpeakingGradingJobRow[]
      >(
        `SELECT ${JOB_COLUMNS} FROM speaking_grading_jobs WHERE job_id = $1 AND organization_id = $2 AND end_user_id = $3 AND environment = $4`,
        jobId,
        owner.organizationId,
        owner.endUserId,
        owner.environment,
      );
      return mapJob(rows[0]);
    });
  }

  async findByIdempotencyKey(input: {
    readonly organizationId: string;
    readonly endUserId: string;
    readonly idempotencyKey: string;
  }): Promise<SpeakingGradingJob | undefined> {
    return this.run(() => selectKeyedJob(this.client, input));
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
        `UPDATE speaking_grading_jobs SET status = 'running', lease_expires_at = $2 WHERE job_id = $1 AND status = 'queued' AND created_at >= $3 RETURNING ${JOB_COLUMNS}`,
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

  async fail(input: {
    readonly jobId: string;
    readonly error: SpeakingGradingJobError;
    readonly completedAt: Date;
  }): Promise<boolean> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly { readonly jobId: string }[]
      >(
        `UPDATE speaking_grading_jobs SET status = 'failed', result = NULL, completed_at = $2, lease_expires_at = NULL, error_code = $3, error_message = $4, error_retryable = $5 WHERE job_id = $1 AND status IN ('queued', 'running') RETURNING job_id AS "jobId"`,
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
    return this.run(() => countInFlight(this.client, input));
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
        `UPDATE speaking_grading_jobs SET status = 'failed', result = NULL, completed_at = $2, lease_expires_at = NULL, error_code = $3, error_message = $4, error_retryable = $5 WHERE status = 'running' AND dispatch_started_at < $1 RETURNING ${JOB_COLUMNS}`,
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
        `UPDATE speaking_grading_jobs SET status = 'failed', result = NULL, completed_at = $2, lease_expires_at = NULL, error_code = $3, error_message = $4, error_retryable = $5 WHERE status = 'queued' AND created_at < $1 RETURNING ${JOB_COLUMNS}`,
        input.createdBefore,
        input.completedAt,
        input.error.code,
        input.error.message,
        input.error.retryable,
      );
      return rows.map(requiredJob);
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
      if (error instanceof AppError) throw error;
      throw databaseUnavailableError(
        error,
        'Speaking grading job store is unavailable',
      );
    }
  }
}
