import { internalError } from '@/common/errors/app-error';
import { SpeakingV2QuestionResultSchema } from '@/contracts/speaking/v2/question-result';
import type { SpeakingV2TestType } from '@/contracts/speaking/v2/response.shared';
import type {
  SpeakingGradingJob,
  SpeakingGradingJobError,
  SpeakingGradingJobStatus,
} from '@/modules/speaking/application/grading-jobs/speaking-grading-job';
import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';
import type { Prisma, PrismaClient } from '@prisma-client/client';
import { Value } from '@sinclair/typebox/value';

export interface SpeakingGradingJobRow {
  readonly jobId: string;
  readonly organizationId: string;
  readonly endUserId: string;
  readonly environment: string;
  readonly identityMode: string;
  readonly apiKeyId: string;
  readonly maxConcurrent: number;
  readonly quotaTracked: boolean;
  readonly quotaUnverified: boolean;
  readonly audioAssetId: string;
  readonly part: number;
  readonly questionId: string;
  readonly promptText: string | null;
  readonly testType: string | null;
  readonly testCode: string | null;
  readonly partResultId: string | null;
  readonly idempotencyKey: string | null;
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

export const JOB_COLUMNS = `
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

export interface InFlightCountInput {
  readonly organizationId: string;
  readonly environment: SpeakingAudioEnvironment;
  readonly since: Date;
}

export async function countInFlight(
  client: PrismaClient | Prisma.TransactionClient,
  input: InFlightCountInput,
): Promise<number> {
  const rows = await client.$queryRawUnsafe<
    readonly { readonly count: bigint }[]
  >(
    `SELECT count(*) AS count FROM speaking_grading_jobs WHERE organization_id = $1 AND environment = $2 AND status IN ('queued', 'running') AND created_at >= $3`,
    input.organizationId,
    input.environment,
    input.since,
  );
  return Number(rows[0]?.count ?? 0n);
}

export async function selectKeyedJob(
  client: PrismaClient | Prisma.TransactionClient,
  input: {
    readonly organizationId: string;
    readonly endUserId: string;
    readonly idempotencyKey: string;
  },
): Promise<SpeakingGradingJob | undefined> {
  const rows = await client.$queryRawUnsafe<readonly SpeakingGradingJobRow[]>(
    `SELECT ${JOB_COLUMNS} FROM speaking_grading_jobs WHERE organization_id = $1 AND end_user_id = $2 AND idempotency_key = $3`,
    input.organizationId,
    input.endUserId,
    input.idempotencyKey,
  );
  return mapJob(rows[0]);
}

export function isKeyUniquenessViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

function invalidStoredJob(): never {
  throw internalError('Speaking grading job store is invalid');
}

function requiredEnvironment(value: string): SpeakingAudioEnvironment {
  if (value !== 'production' && value !== 'sandbox') {
    return invalidStoredJob();
  }
  return value;
}

function requiredIdentityMode(
  value: string,
): SpeakingGradingJob['identityMode'] {
  if (value !== 'declared_id' && value !== 'signed_assertion') {
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

export function mapJob(
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
    identityMode: requiredIdentityMode(row.identityMode),
    apiKeyId: row.apiKeyId,
    maxConcurrent: row.maxConcurrent,
    quotaTracked: row.quotaTracked,
    quotaUnverified: row.quotaUnverified,
    ...(row.idempotencyKey === null
      ? {}
      : { idempotencyKey: row.idempotencyKey }),
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

export function requiredJob(row: SpeakingGradingJobRow): SpeakingGradingJob {
  const job = mapJob(row);
  if (job === undefined) return invalidStoredJob();
  return job;
}

export function mapIdEnvironment(row: {
  readonly jobId: string;
  readonly environment: string;
}): { readonly jobId: string; readonly environment: SpeakingAudioEnvironment } {
  return {
    jobId: row.jobId,
    environment: requiredEnvironment(row.environment),
  };
}
