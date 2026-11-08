import type { SandboxDispatchBudgetPort } from '@/modules/gateway/public/sandbox-dispatch-budget';
import {
  SPEAKING_GRADING_JOB_ERRORS,
  type SpeakingGradingJob,
  type SpeakingGradingJobError,
} from './speaking-grading-job';
import { SPEAKING_GRADING_JOB_POLICY } from './speaking-grading-job.policy';
import type {
  SpeakingGradingJobQueuePort,
  SpeakingGradingJobRepositoryPort,
} from './speaking-grading-job.port';

const DISPATCH_INTERRUPTED: SpeakingGradingJobError = {
  code: 'DISPATCH_INTERRUPTED',
  message: 'Speaking grading dispatch was interrupted',
  retryable: SPEAKING_GRADING_JOB_ERRORS.DISPATCH_INTERRUPTED.retryable,
};
const JOB_EXPIRED: SpeakingGradingJobError = {
  code: 'JOB_EXPIRED',
  message: 'Speaking grading job expired before dispatch',
  retryable: SPEAKING_GRADING_JOB_ERRORS.JOB_EXPIRED.retryable,
};

export interface SpeakingGradingJobSweepSummary {
  readonly staleQueuedEnqueued: number;
  readonly expiredLeasesEnqueued: number;
  readonly interrupted: number;
  readonly expired: number;
  readonly sandboxReservationsReleased: number;
  readonly deleted: number;
  readonly failedSteps: readonly string[];
}

/** Reconciles durable job state; each step is isolated so one store failure cannot stall the rest. */
export class SpeakingGradingJobSweep {
  constructor(
    private readonly repository: Pick<
      SpeakingGradingJobRepositoryPort,
      | 'listStaleQueued'
      | 'releaseExpiredLeases'
      | 'interruptStaleDispatches'
      | 'expireQueued'
      | 'deleteCreatedBefore'
    >,
    private readonly queue: Pick<SpeakingGradingJobQueuePort, 'enqueue'>,
    private readonly sandboxBudget: Pick<SandboxDispatchBudgetPort, 'release'>,
  ) {}

  async run(now: Date): Promise<SpeakingGradingJobSweepSummary> {
    const failedSteps: string[] = [];
    let staleQueuedEnqueued = 0;
    let expiredLeasesEnqueued = 0;
    let interrupted = 0;
    let expired = 0;
    let sandboxReservationsReleased = 0;
    let deleted = 0;

    await this.step(failedSteps, 'staleQueued', async () => {
      const jobs = await this.repository.listStaleQueued({
        createdBefore: new Date(
          now.getTime() - SPEAKING_GRADING_JOB_POLICY.reenqueueAfterMs,
        ),
        limit: SPEAKING_GRADING_JOB_POLICY.sweepBatchSize,
      });
      staleQueuedEnqueued = await this.enqueueEach(
        jobs,
        failedSteps,
        'staleQueuedEnqueue',
      );
    });

    await this.step(failedSteps, 'releaseExpiredLeases', async () => {
      const jobs = await this.repository.releaseExpiredLeases(now);
      expiredLeasesEnqueued = await this.enqueueEach(
        jobs,
        failedSteps,
        'expiredLeaseEnqueue',
      );
    });

    await this.step(failedSteps, 'interruptStaleDispatches', async () => {
      const jobs = await this.repository.interruptStaleDispatches({
        startedBefore: new Date(
          now.getTime() -
            SPEAKING_GRADING_JOB_POLICY.dispatchInterruptedAfterMs,
        ),
        error: DISPATCH_INTERRUPTED,
        completedAt: now,
      });
      interrupted = jobs.length;
    });

    await this.step(failedSteps, 'expireQueued', async () => {
      const jobs = await this.repository.expireQueued({
        createdBefore: new Date(
          now.getTime() - SPEAKING_GRADING_JOB_POLICY.queueExpiryMs,
        ),
        error: JOB_EXPIRED,
        completedAt: now,
      });
      expired = jobs.length;
      for (const job of jobs) {
        if (job.environment !== 'sandbox') continue;
        try {
          await this.sandboxBudget.release(job.jobId);
          sandboxReservationsReleased += 1;
        } catch {
          failedSteps.push('releaseExpiredSandboxReservation');
        }
      }
    });

    await this.step(failedSteps, 'deleteCreatedBefore', async () => {
      deleted = await this.repository.deleteCreatedBefore(
        new Date(now.getTime() - SPEAKING_GRADING_JOB_POLICY.retentionMs),
      );
    });

    return {
      staleQueuedEnqueued,
      expiredLeasesEnqueued,
      interrupted,
      expired,
      sandboxReservationsReleased,
      deleted,
      failedSteps: [...new Set(failedSteps)],
    };
  }

  private async enqueueEach(
    jobs: readonly {
      readonly jobId: string;
      readonly environment: SpeakingGradingJob['environment'];
    }[],
    failedSteps: string[],
    failureName: string,
  ): Promise<number> {
    let enqueued = 0;
    let failed = false;
    for (const job of jobs) {
      try {
        await this.queue.enqueue({
          jobId: job.jobId,
          environment: job.environment,
        });
        enqueued += 1;
      } catch {
        failed = true;
      }
    }
    if (failed) failedSteps.push(failureName);
    return enqueued;
  }

  private async step(
    failedSteps: string[],
    name: string,
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch {
      failedSteps.push(name);
    }
  }
}
