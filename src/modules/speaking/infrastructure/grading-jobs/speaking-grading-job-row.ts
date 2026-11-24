import { internalError } from '@/common/errors/app-error';
import { findPostgresErrorLink } from '@/common/postgres/postgres-error-chain';
import { SpeakingV2QuestionResultSchema } from '@/contracts/speaking/v2/question-result';
import type { SpeakingV2TestType } from '@/contracts/speaking/v2/response.shared';
import type {
  SpeakingGradingJob,
  SpeakingGradingJobError,
  SpeakingGradingJobStatus,
} from '@/modules/speaking/application/grading-jobs/speaking-grading-job';
import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';
import type { Prisma, PrismaClient } from '@prisma-client/client';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { jobColumns } from './speaking-grading-job-columns';

const StoredSpeakingV2QuestionResultSchema = Type.Object(
  {
    ...SpeakingV2QuestionResultSchema.properties,
    error_priority: Type.Optional(
      SpeakingV2QuestionResultSchema.properties.error_priority,
    ),
  },
  { additionalProperties: false },
);

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

export interface InFlightCountInput {
  readonly organizationId: string;
  readonly environment: SpeakingAudioEnvironment;
}

/**
 * Counts every active quota reservation regardless of `created_at`: a job
 * submitted just before a UTC month boundary is metered in the month it
 * dispatches, so its reservation must still count after the boundary. Active
 * reservations are short-lived (queue expiry, dispatch interrupt, settlement
 * sweep), so the unbounded range stays small.
 *
 * A job the meter has already counted is excluded even while its reservation
 * stays active (#1950): the meter increments the live counter before it
 * writes the record, so counting both would charge one request twice and a
 * caller could be refused `QUOTA_EXCEEDED` with quota left. A billable record
 * is the condition the finalizer uses to attempt that increment; an increment
 * that throws is already fail-open there (ADR-0018), so this count takes the
 * record at its word rather than second-guessing the counter. Releasing the
 * reservation stays a separate, later step, so a release that failed no longer
 * pins the count for the sweep's two-minute grace window either. A handoff that
 * never wrote a record still counts until the sweep releases it.
 */
export async function countInFlight(
  client: PrismaClient | Prisma.TransactionClient,
  input: InFlightCountInput,
): Promise<number> {
  const rows = await client.$queryRawUnsafe<
    readonly { readonly count: bigint }[]
  >(
    `SELECT count(*) AS count FROM speaking_grading_jobs j
     WHERE j.organization_id = $1 AND j.environment = $2
       AND j.status IN ('queued', 'running', 'succeeded')
       AND j.quota_reservation_active = true
       AND NOT EXISTS (
         SELECT 1 FROM usage_records u
         WHERE u.request_id = j.job_id AND u.billable_requests = 1
       )`,
    input.organizationId,
    input.environment,
  );
  return Number(rows[0]?.count ?? 0n);
}

export async function selectKeyedJob(
  client: PrismaClient | Prisma.TransactionClient,
  input: {
    readonly organizationId: string;
    readonly endUserId: string;
    readonly idempotencyKey: string;
    readonly unexpiredSince?: Date;
  },
): Promise<SpeakingGradingJob | undefined> {
  if (input.unexpiredSince === undefined) {
    const rows = await client.$queryRawUnsafe<readonly SpeakingGradingJobRow[]>(
      `SELECT ${jobColumns()} FROM speaking_grading_jobs WHERE organization_id = $1 AND end_user_id = $2 AND idempotency_key = $3`,
      input.organizationId,
      input.endUserId,
      input.idempotencyKey,
    );
    return mapJob(rows[0]);
  }
  const rows = await client.$queryRawUnsafe<readonly SpeakingGradingJobRow[]>(
    `SELECT ${jobColumns()} FROM speaking_grading_jobs WHERE organization_id = $1 AND end_user_id = $2 AND idempotency_key = $3 AND created_at >= $4`,
    input.organizationId,
    input.endUserId,
    input.idempotencyKey,
    input.unexpiredSince,
  );
  return mapJob(rows[0]);
}

export async function clearExpiredKeyedJobs(
  client: PrismaClient | Prisma.TransactionClient,
  input: {
    readonly organizationId: string;
    readonly endUserId: string;
    readonly idempotencyKey: string;
    readonly expiredBefore: Date;
  },
): Promise<void> {
  await client.$executeRawUnsafe(
    `UPDATE speaking_grading_jobs SET idempotency_key = NULL WHERE organization_id = $1 AND end_user_id = $2 AND idempotency_key = $3 AND created_at < $4`,
    input.organizationId,
    input.endUserId,
    input.idempotencyKey,
    input.expiredBefore,
  );
}

export function isKeyUniquenessViolation(error: unknown): boolean {
  return (
    findPostgresErrorLink(
      error,
      (link) =>
        link.code === '23505' &&
        typeof link.message === 'string' &&
        link.message.includes('speaking_grading_jobs_org_user_key_idx'),
    ) !== undefined
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
    if (!Value.Check(StoredSpeakingV2QuestionResultSchema, row.result)) {
      return invalidStoredJob();
    }
    const storedResult = Value.Parse(
      StoredSpeakingV2QuestionResultSchema,
      row.result,
    );
    result = {
      ...storedResult,
      error_priority: storedResult.error_priority ?? [],
    };
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
