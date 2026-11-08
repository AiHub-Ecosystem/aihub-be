import type { SandboxDispatchBudgetPort } from '@/modules/gateway/public/sandbox-dispatch-budget';
import type {
  SpeakingGradingJob,
  SpeakingGradingJobError,
} from './speaking-grading-job';
import { SPEAKING_GRADING_JOB_POLICY } from './speaking-grading-job.policy';
import type {
  SpeakingGradingJobQueuePort,
  SpeakingGradingJobRepositoryPort,
} from './speaking-grading-job.port';
import { SpeakingGradingJobSweep } from './speaking-grading-job.sweep';

const NOW = new Date('2026-11-08T01:00:00.000Z');
const job = (
  jobId: string,
  environment: SpeakingGradingJob['environment'],
): SpeakingGradingJob => ({
  jobId,
  organizationId: 'org_acme',
  endUserId: 'user_acme',
  environment,
  identityMode: 'declared_id',
  apiKeyId: 'ak_acme',
  maxConcurrent: 2,
  quotaTracked: true,
  audioAssetId: 'aud_01J00000000000000000000001',
  request: { part: 1, questionId: 'question-1' },
  status: 'failed',
  createdAt: NOW,
});

describe('SpeakingGradingJobSweep', () => {
  it('runs all five recovery steps with the policy thresholds', async () => {
    const interruptedJob = job('sgj_01J00000000000000000000001', 'production');
    const expiredSandboxJob = job('sgj_01J00000000000000000000002', 'sandbox');
    const expiredProductionJob = job(
      'sgj_01J00000000000000000000003',
      'production',
    );
    const repository = {
      listStaleQueued: jest.fn(async () => [
        {
          jobId: 'sgj_01J00000000000000000000004',
          environment: 'production' as const,
        },
      ]),
      releaseExpiredLeases: jest.fn(async () => [
        {
          jobId: 'sgj_01J00000000000000000000005',
          environment: 'sandbox' as const,
        },
      ]),
      interruptStaleDispatches: jest.fn(async () => [interruptedJob]),
      expireQueued: jest.fn(async () => [
        expiredSandboxJob,
        expiredProductionJob,
      ]),
      deleteCreatedBefore: jest.fn(async () => 7),
    } satisfies Pick<
      SpeakingGradingJobRepositoryPort,
      | 'listStaleQueued'
      | 'releaseExpiredLeases'
      | 'interruptStaleDispatches'
      | 'expireQueued'
      | 'deleteCreatedBefore'
    >;
    const queue = {
      enqueue: jest.fn(async () => undefined),
    } satisfies Pick<SpeakingGradingJobQueuePort, 'enqueue'>;
    const release = jest.fn(async () => undefined);
    const sandboxBudget = { release } satisfies Pick<
      SandboxDispatchBudgetPort,
      'release'
    >;
    const sweep = new SpeakingGradingJobSweep(repository, queue, sandboxBudget);

    await expect(sweep.run(NOW)).resolves.toEqual({
      staleQueuedEnqueued: 1,
      expiredLeasesEnqueued: 1,
      interrupted: 1,
      expired: 2,
      sandboxReservationsReleased: 1,
      deleted: 7,
      failedSteps: [],
    });
    expect(repository.listStaleQueued).toHaveBeenCalledWith({
      createdBefore: new Date(
        NOW.getTime() - SPEAKING_GRADING_JOB_POLICY.reenqueueAfterMs,
      ),
      limit: SPEAKING_GRADING_JOB_POLICY.sweepBatchSize,
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(repository.releaseExpiredLeases).toHaveBeenCalledWith(NOW);
    expect(repository.interruptStaleDispatches).toHaveBeenCalledWith(
      expect.objectContaining({
        startedBefore: new Date(
          NOW.getTime() -
            SPEAKING_GRADING_JOB_POLICY.dispatchInterruptedAfterMs,
        ),
        error: expect.objectContaining({
          code: 'DISPATCH_INTERRUPTED',
        }) as unknown as SpeakingGradingJobError,
        completedAt: NOW,
      }),
    );
    expect(repository.expireQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBefore: new Date(
          NOW.getTime() - SPEAKING_GRADING_JOB_POLICY.queueExpiryMs,
        ),
        error: expect.objectContaining({
          code: 'JOB_EXPIRED',
        }) as unknown as SpeakingGradingJobError,
        completedAt: NOW,
      }),
    );
    expect(release).toHaveBeenCalledWith(expiredSandboxJob.jobId);
    expect(release).toHaveBeenCalledTimes(1);
    expect(repository.deleteCreatedBefore).toHaveBeenCalledWith(
      new Date(NOW.getTime() - SPEAKING_GRADING_JOB_POLICY.retentionMs),
    );
  });

  it('continues remaining steps if one repository step throws', async () => {
    const repository = {
      listStaleQueued: jest.fn(async () => {
        throw new Error('temporary database failure');
      }),
      releaseExpiredLeases: jest.fn(async () => []),
      interruptStaleDispatches: jest.fn(async () => []),
      expireQueued: jest.fn(async () => []),
      deleteCreatedBefore: jest.fn(async () => 0),
    } satisfies Pick<
      SpeakingGradingJobRepositoryPort,
      | 'listStaleQueued'
      | 'releaseExpiredLeases'
      | 'interruptStaleDispatches'
      | 'expireQueued'
      | 'deleteCreatedBefore'
    >;
    const queue = { enqueue: jest.fn(async () => undefined) } satisfies Pick<
      SpeakingGradingJobQueuePort,
      'enqueue'
    >;
    const sandboxBudget = {
      release: jest.fn(async () => undefined),
    } satisfies Pick<SandboxDispatchBudgetPort, 'release'>;

    const summary = await new SpeakingGradingJobSweep(
      repository,
      queue,
      sandboxBudget,
    ).run(NOW);

    expect(summary.failedSteps).toContain('staleQueued');
    expect(repository.releaseExpiredLeases).toHaveBeenCalled();
    expect(repository.interruptStaleDispatches).toHaveBeenCalled();
    expect(repository.expireQueued).toHaveBeenCalled();
    expect(repository.deleteCreatedBefore).toHaveBeenCalled();
  });

  it('continues enqueuing the rest of a batch when one enqueue fails', async () => {
    const repository = {
      listStaleQueued: jest.fn(async () => [
        {
          jobId: 'sgj_01J00000000000000000000004',
          environment: 'production' as const,
        },
        {
          jobId: 'sgj_01J00000000000000000000005',
          environment: 'sandbox' as const,
        },
      ]),
      releaseExpiredLeases: jest.fn(async () => []),
      interruptStaleDispatches: jest.fn(async () => []),
      expireQueued: jest.fn(async () => []),
      deleteCreatedBefore: jest.fn(async () => 0),
    } satisfies Pick<
      SpeakingGradingJobRepositoryPort,
      | 'listStaleQueued'
      | 'releaseExpiredLeases'
      | 'interruptStaleDispatches'
      | 'expireQueued'
      | 'deleteCreatedBefore'
    >;
    const queue = {
      enqueue: jest
        .fn<
          Promise<void>,
          [Parameters<SpeakingGradingJobQueuePort['enqueue']>[0]]
        >()
        .mockRejectedValueOnce(new Error('queue unavailable'))
        .mockResolvedValue(undefined),
    } satisfies Pick<SpeakingGradingJobQueuePort, 'enqueue'>;
    const sandboxBudget = {
      release: jest.fn(async () => undefined),
    } satisfies Pick<SandboxDispatchBudgetPort, 'release'>;

    const summary = await new SpeakingGradingJobSweep(
      repository,
      queue,
      sandboxBudget,
    ).run(NOW);

    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(summary.staleQueuedEnqueued).toBe(1);
    expect(summary.failedSteps).toContain('staleQueuedEnqueue');
  });
});
