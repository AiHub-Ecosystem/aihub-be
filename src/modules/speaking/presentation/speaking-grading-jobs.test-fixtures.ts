import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { internalError } from '@/common/errors/app-error';

import type { SpeakingV2QuestionResult } from '@/contracts/speaking/v2/question-result';
import type {
  NewSpeakingGradingJob,
  SpeakingGradingJob,
  SpeakingGradingJobError,
  SpeakingGradingJobOwner,
} from '@/modules/speaking/application/grading-jobs/speaking-grading-job';
import type {
  SpeakingGradingJobQueuePort,
  SpeakingGradingJobRepositoryPort,
} from '@/modules/speaking/application/grading-jobs/speaking-grading-job.port';
import type {
  SpeakingAudioUploadLookup,
  SpeakingAudioUploadOwner,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/speaking-audio-upload.port';
import type {
  SpeakingAudioAsset,
  SpeakingAudioEnvironment,
} from '@/modules/speaking/domain/speaking-audio-asset';

export const JOB_ID = 'sgj_01J00000000000000000000001';
export const ASSET_ID = 'aud_01J00000000000000000000001';
export const OWNER: SpeakingGradingJobOwner = {
  organizationId: 'org_test',
  endUserId: 'user_test',
  environment: 'production',
};
export const REQUEST_BODY = {
  audio_asset_id: ASSET_ID,
  part: 1,
  question_id: 'p1_hometown',
};

function ownerKey(owner: SpeakingGradingJobOwner): string {
  return JSON.stringify([
    owner.organizationId,
    owner.endUserId,
    owner.environment,
  ]);
}

export class FakeJobRepository implements SpeakingGradingJobRepositoryPort {
  readonly jobs = new Map<string, SpeakingGradingJob>();

  seed(job: SpeakingGradingJob): void {
    this.jobs.set(job.jobId, job);
  }

  async create(job: NewSpeakingGradingJob): Promise<void> {
    this.jobs.set(job.jobId, { ...job, status: 'queued' });
  }

  async createWithAdmission(input: {
    readonly job: NewSpeakingGradingJob;
    readonly since: Date;
    readonly monthlyQuota: number | null;
    readonly admit: (monthlyQuota: number | null) => Promise<boolean>;
  }): Promise<boolean> {
    const inFlight =
      input.monthlyQuota === null
        ? 0
        : await this.countInFlight({
            organizationId: input.job.organizationId,
            environment: input.job.environment,
            since: input.since,
          });
    const monthlyQuota =
      input.monthlyQuota === null
        ? null
        : Math.max(0, input.monthlyQuota - inFlight);
    if (!(await input.admit(monthlyQuota))) return false;
    await this.create(input.job);
    return true;
  }

  async findOwned(owner: SpeakingGradingJobOwner, jobId: string) {
    const job = this.jobs.get(jobId);
    return job !== undefined && ownerKey(job) === ownerKey(owner)
      ? job
      : undefined;
  }

  async claim(
    input: Parameters<SpeakingGradingJobRepositoryPort['claim']>[0],
  ): Promise<SpeakingGradingJob | undefined> {
    const job = this.jobs.get(input.jobId);
    if (job === undefined || job.status !== 'queued') return undefined;
    const claimed = {
      ...job,
      status: 'running' as const,
      leaseExpiresAt: input.leaseExpiresAt,
    };
    this.jobs.set(input.jobId, claimed);
    return claimed;
  }

  async returnToQueue(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (
      job === undefined ||
      job.status !== 'running' ||
      job.dispatchStartedAt !== undefined
    ) {
      return false;
    }
    this.jobs.set(jobId, { ...job, status: 'queued' });
    return true;
  }

  async markDispatchStarted(jobId: string, now: Date): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (
      job === undefined ||
      job.status !== 'running' ||
      job.dispatchStartedAt !== undefined
    ) {
      return false;
    }
    this.jobs.set(jobId, { ...job, dispatchStartedAt: now });
    return true;
  }

  async succeed(input: {
    readonly jobId: string;
    readonly result: NonNullable<SpeakingGradingJob['result']>;
    readonly completedAt: Date;
  }): Promise<boolean> {
    const job = this.jobs.get(input.jobId);
    if (job === undefined || job.status !== 'running') return false;
    this.jobs.set(input.jobId, {
      ...job,
      status: 'succeeded',
      result: input.result,
      completedAt: input.completedAt,
    });
    return true;
  }

  async fail(input: {
    readonly jobId: string;
    readonly error: SpeakingGradingJobError;
    readonly completedAt: Date;
  }): Promise<boolean> {
    const job = this.jobs.get(input.jobId);
    if (
      job === undefined ||
      (job.status !== 'queued' && job.status !== 'running')
    ) {
      return false;
    }
    this.jobs.set(input.jobId, {
      ...job,
      status: 'failed',
      error: input.error,
      completedAt: input.completedAt,
    });
    return true;
  }

  async countInFlight(input: {
    readonly organizationId: string;
    readonly environment: SpeakingAudioEnvironment;
    readonly since: Date;
  }): Promise<number> {
    return [...this.jobs.values()].filter(
      (job) =>
        job.organizationId === input.organizationId &&
        job.environment === input.environment &&
        job.createdAt >= input.since &&
        (job.status === 'queued' || job.status === 'running'),
    ).length;
  }

  async listStaleQueued(
    input: Parameters<SpeakingGradingJobRepositoryPort['listStaleQueued']>[0],
  ): Promise<
    readonly { jobId: string; environment: SpeakingAudioEnvironment }[]
  > {
    return [...this.jobs.values()]
      .filter(
        (job) => job.status === 'queued' && job.createdAt < input.createdBefore,
      )
      .sort(
        (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
      )
      .slice(0, input.limit)
      .map(({ jobId, environment }) => ({ jobId, environment }));
  }

  async releaseExpiredLeases(
    now: Date,
  ): Promise<
    readonly { jobId: string; environment: SpeakingAudioEnvironment }[]
  > {
    const released = [];
    for (const job of this.jobs.values()) {
      if (
        job.status !== 'running' ||
        job.dispatchStartedAt !== undefined ||
        job.leaseExpiresAt === undefined ||
        job.leaseExpiresAt > now
      ) {
        continue;
      }
      this.jobs.set(job.jobId, { ...job, status: 'queued' });
      released.push({ jobId: job.jobId, environment: job.environment });
    }
    return released;
  }

  async interruptStaleDispatches(
    input: Parameters<
      SpeakingGradingJobRepositoryPort['interruptStaleDispatches']
    >[0],
  ): Promise<readonly SpeakingGradingJob[]> {
    const interrupted: SpeakingGradingJob[] = [];
    for (const job of this.jobs.values()) {
      if (
        job.status !== 'running' ||
        job.dispatchStartedAt === undefined ||
        job.dispatchStartedAt >= input.startedBefore
      ) {
        continue;
      }
      const failed = {
        ...job,
        status: 'failed' as const,
        error: input.error,
        completedAt: input.completedAt,
      };
      this.jobs.set(job.jobId, failed);
      interrupted.push(failed);
    }
    return interrupted;
  }

  async expireQueued(
    input: Parameters<SpeakingGradingJobRepositoryPort['expireQueued']>[0],
  ): Promise<readonly SpeakingGradingJob[]> {
    const expired: SpeakingGradingJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== 'queued' || job.createdAt >= input.createdBefore) {
        continue;
      }
      const failed = {
        ...job,
        status: 'failed' as const,
        error: input.error,
        completedAt: input.completedAt,
      };
      this.jobs.set(job.jobId, failed);
      expired.push(failed);
    }
    return expired;
  }

  async deleteCreatedBefore(createdBefore: Date): Promise<number> {
    let deleted = 0;
    for (const [jobId, job] of this.jobs) {
      if (job.createdAt < createdBefore) {
        this.jobs.delete(jobId);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export class FakeAudioRepository implements SpeakingAudioUploadRepositoryPort {
  readonly assets = new Map<string, SpeakingAudioAsset>();

  seed(asset: SpeakingAudioAsset): void {
    this.assets.set(asset.assetId, asset);
  }

  async findUpload(
    owner: SpeakingAudioUploadOwner,
  ): Promise<SpeakingAudioUploadLookup> {
    const asset = this.assets.get(owner.assetId);
    return asset !== undefined &&
      asset.organizationId === owner.organizationId &&
      asset.endUserId === owner.endUserId &&
      asset.environment === owner.environment
      ? { kind: 'asset', asset }
      : { kind: 'missing' };
  }

  async createIntent(): Promise<void> {}
  async confirmRefreshableIntent(): Promise<boolean> {
    return false;
  }
  async removeRejectedIntent(): Promise<void> {}
  async completeIntent(): ReturnType<
    SpeakingAudioUploadRepositoryPort['completeIntent']
  > {
    return { kind: 'missing' };
  }
  async listCleanupCandidates(): Promise<readonly never[]> {
    return [];
  }
  async removeCleanupCandidate(): Promise<boolean> {
    return false;
  }
}

export class FakeQueue implements SpeakingGradingJobQueuePort {
  readonly attempts: string[] = [];
  readonly enqueued: string[] = [];
  failNext = false;

  async enqueue(
    input: Parameters<SpeakingGradingJobQueuePort['enqueue']>[0],
  ): Promise<void> {
    this.attempts.push(input.jobId);
    if (this.failNext) {
      this.failNext = false;
      throw internalError('queue unavailable');
    }
    this.enqueued.push(input.jobId);
  }
}

export function speakingAsset(
  owner: SpeakingGradingJobOwner = OWNER,
  retentionExpiresAt = new Date(Date.now() + 60_000),
): SpeakingAudioAsset {
  return {
    assetId: ASSET_ID,
    organizationId: owner.organizationId,
    endUserId: owner.endUserId,
    environment: owner.environment,
    objectKey: `orgs/${owner.organizationId}/speaking/${ASSET_ID}/original`,
    contentType: 'audio/wav',
    byteSize: 200,
    acceptedAt: new Date(Date.now() - 60_000),
    retentionExpiresAt,
  };
}

function speakingResult(): SpeakingV2QuestionResult {
  const fixturePath = join(
    __dirname,
    '../../../../test/fixtures/ai-speaking/grading-v2-question-post.200.json',
  );
  const parsed = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    readonly data: SpeakingV2QuestionResult;
  };
  const result = parsed.data;
  return { ...result, meta: { ...result.meta, response_id: 'resp_123' } };
}

export function seededJob(
  status: SpeakingGradingJob['status'],
  owner: SpeakingGradingJobOwner = OWNER,
): SpeakingGradingJob {
  return {
    ...owner,
    jobId: JOB_ID,
    apiKeyId: 'ak_test',
    maxConcurrent: 4,
    quotaTracked: true,
    audioAssetId: ASSET_ID,
    request: { part: 1, questionId: 'p1_hometown' },
    status,
    createdAt: new Date('2026-11-08T00:00:00.000Z'),
    ...(status === 'succeeded'
      ? {
          completedAt: new Date('2026-11-08T00:01:00.000Z'),
          result: speakingResult(),
        }
      : status === 'failed'
        ? {
            completedAt: new Date('2026-11-08T00:01:00.000Z'),
            error: {
              code: 'AUDIO_UNREADABLE',
              message: 'The audio could not be read',
              retryable: false,
            },
          }
        : {}),
  };
}
