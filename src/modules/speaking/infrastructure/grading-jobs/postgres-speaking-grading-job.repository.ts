import { AppError, internalError } from '@/common/errors/app-error';
import { databaseUnavailableError } from '@/common/postgres/postgres-unavailable-error';
import { SpeakingV2QuestionResultSchema } from '@/contracts/speaking/v2/question-result';
import type { SpeakingV2TestType } from '@/contracts/speaking/v2/response.shared';
import type {
  NewSpeakingGradingJob,
  SpeakingGradingJob,
  SpeakingGradingJobError,
  SpeakingGradingJobOwner,
  SpeakingGradingJobStatus,
} from '@/modules/speaking/application/grading-jobs/speaking-grading-job';
import type { SpeakingGradingJobRepositoryPort } from '@/modules/speaking/application/grading-jobs/speaking-grading-job.port';
import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';
import type { PrismaClient } from '@prisma-client/client';
import { Value } from '@sinclair/typebox/value';

interface SpeakingGradingJobRow {
  readonly jobId: string;
  readonly organizationId: string;
  readonly endUserId: string;
  readonly environment: string;
  readonly apiKeyId: string;
  readonly maxConcurrent: number;
  readonly quotaTracked: boolean;
  readonly audioAssetId: string;
  readonly part: number;
  readonly questionId: string;
  readonly promptText: string | null;
  readonly testType: string | null;
  readonly testCode: string | null;
  readonly partResultId: string | null;
  readonly status: string;
  readonly leaseExpiresAt: Date | null;
  readonly dispatchStartedAt: Date | null;
  readonly result: unknown;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly errorRetryable: boolean | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

const JOB_COLUMNS = `
  job_id AS "jobId",
  organization_id AS "organizationId",
  end_user_id AS "endUserId",
  environment,
  api_key_id AS "apiKeyId",
  max_concurrent AS "maxConcurrent",
  quota_tracked AS "quotaTracked",
  audio_asset_id AS "audioAssetId",
  part,
  question_id AS "questionId",
  prompt_text AS "promptText",
  test_type AS "testType",
  test_code AS "testCode",
  part_result_id AS "partResultId",
  status,
  lease_expires_at AS "leaseExpiresAt",
  dispatch_started_at AS "dispatchStartedAt",
  result,
  error_code AS "errorCode",
  error_message AS "errorMessage",
  error_retryable AS "errorRetryable",
  created_at AS "createdAt",
  completed_at AS "completedAt"`;

function invalidStoredJob(): never {
  throw internalError('Speaking grading job store is invalid');
}

function requiredEnvironment(value: string): SpeakingAudioEnvironment {
  if (value !== 'production' && value !== 'sandbox') {
    return invalidStoredJob();
  }
  return value;
}

function requiredStatus(value: string): SpeakingGradingJobStatus {
  if (
    value !== 'queued' &&
    value !== 'running' &&
    value !== 'succeeded' &&
    value !== 'failed'
  ) {
    return invalidStoredJob();
  }
  return value;
}

function mapJob(
  row: SpeakingGradingJobRow | undefined,
): SpeakingGradingJob | undefined {
  if (row === undefined) return undefined;
  if (!Number.isSafeInteger(row.maxConcurrent) || row.maxConcurrent < 1) {
    return invalidStoredJob();
  }

  let testType: SpeakingV2TestType | undefined;
  if (row.testType !== null) {
    if (row.testType !== 'practice' && row.testType !== 'full_test') {
      return invalidStoredJob();
    }
    testType = row.testType;
  }

  let result: SpeakingGradingJob['result'];
  if (row.result !== null) {
    if (!Value.Check(SpeakingV2QuestionResultSchema, row.result)) {
      return invalidStoredJob();
    }
    result = Value.Parse(SpeakingV2QuestionResultSchema, row.result);
  }

  let error: SpeakingGradingJobError | undefined;
  const hasErrorField =
    row.errorCode !== null ||
    row.errorMessage !== null ||
    row.errorRetryable !== null;
  if (hasErrorField) {
    if (
      row.errorCode === null ||
      row.errorMessage === null ||
      row.errorRetryable === null
    ) {
      return invalidStoredJob();
    }
    error = {
      code: row.errorCode,
      message: row.errorMessage,
      retryable: row.errorRetryable,
    };
  }

  return {
    jobId: row.jobId,
    organizationId: row.organizationId,
    endUserId: row.endUserId,
    environment: requiredEnvironment(row.environment),
    apiKeyId: row.apiKeyId,
    maxConcurrent: row.maxConcurrent,
    quotaTracked: row.quotaTracked,
    audioAssetId: row.audioAssetId,
    request: {
      part: row.part,
      questionId: row.questionId,
      ...(row.promptText === null ? {} : { promptText: row.promptText }),
      ...(testType === undefined ? {} : { testType }),
      ...(row.testCode === null ? {} : { testCode: row.testCode }),
      ...(row.partResultId === null ? {} : { partResultId: row.partResultId }),
    },
    status: requiredStatus(row.status),
    createdAt: row.createdAt,
    ...(row.leaseExpiresAt === null
      ? {}
      : { leaseExpiresAt: row.leaseExpiresAt }),
    ...(row.dispatchStartedAt === null
      ? {}
      : { dispatchStartedAt: row.dispatchStartedAt }),
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  };
}

function requiredJob(row: SpeakingGradingJobRow): SpeakingGradingJob {
  const job = mapJob(row);
  if (job === undefined) return invalidStoredJob();
  return job;
}

function mapIdEnvironment(row: {
  readonly jobId: string;
  readonly environment: string;
}): { readonly jobId: string; readonly environment: SpeakingAudioEnvironment } {
  return {
    jobId: row.jobId,
    environment: requiredEnvironment(row.environment),
  };
}

export class PostgresSpeakingGradingJobRepository
  implements SpeakingGradingJobRepositoryPort
{
  constructor(private readonly client: PrismaClient) {}

  async create(job: NewSpeakingGradingJob): Promise<void> {
    await this.run(async () => {
      await this.client.$executeRawUnsafe(
        `INSERT INTO speaking_grading_jobs (job_id, organization_id, end_user_id, environment, api_key_id, quota_tracked, max_concurrent, audio_asset_id, part, question_id, prompt_text, test_type, test_code, part_result_id, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'queued', $15)`,
        job.jobId,
        job.organizationId,
        job.endUserId,
        job.environment,
        job.apiKeyId,
        job.quotaTracked,
        job.maxConcurrent,
        job.audioAssetId,
        job.request.part,
        job.request.questionId,
        job.request.promptText ?? null,
        job.request.testType ?? null,
        job.request.testCode ?? null,
        job.request.partResultId ?? null,
        job.createdAt,
      );
    });
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

  async claim(input: {
    readonly jobId: string;
    readonly now: Date;
    readonly leaseExpiresAt: Date;
  }): Promise<SpeakingGradingJob | undefined> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly SpeakingGradingJobRow[]
      >(
        `UPDATE speaking_grading_jobs SET status = 'running', lease_expires_at = $2 WHERE job_id = $1 AND status = 'queued' RETURNING ${JOB_COLUMNS}`,
        input.jobId,
        input.leaseExpiresAt,
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

  async countInFlight(input: {
    readonly organizationId: string;
    readonly environment: SpeakingAudioEnvironment;
    readonly since: Date;
  }): Promise<number> {
    return this.run(async () => {
      const rows = await this.client.$queryRawUnsafe<
        readonly { readonly count: bigint }[]
      >(
        `SELECT count(*) AS count FROM speaking_grading_jobs WHERE organization_id = $1 AND environment = $2 AND status IN ('queued', 'running') AND created_at >= $3`,
        input.organizationId,
        input.environment,
        input.since,
      );
      return Number(rows[0]?.count ?? 0n);
    });
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
