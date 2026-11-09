import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';

import {
  backgroundWorkSettled,
  backgroundWorkStarted,
} from '@/common/background-work-tracker';
import { SPEAKING_GRADING_JOB_POLICY } from '@/modules/speaking/application/grading-jobs/speaking-grading-job.policy';
import type { SpeakingGradingJobSweep } from '@/modules/speaking/application/grading-jobs/speaking-grading-job.sweep';

/** Runs one in-process sweep at the accepted policy interval and joins shutdown draining. */
export class SpeakingGradingJobSweepScheduler
  implements OnModuleInit, OnApplicationShutdown
{
  private timer: NodeJS.Timeout | undefined;
  private activePass: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly sweep: Pick<SpeakingGradingJobSweep, 'run'>,
    private readonly now: () => Date = () => new Date(),
    private readonly intervalMs = SPEAKING_GRADING_JOB_POLICY.sweepIntervalMs,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.runPass(), this.intervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activePass;
  }

  private runPass(): void {
    if (this.stopping || this.activePass !== undefined) return;
    backgroundWorkStarted();
    this.activePass = this.sweep
      .run(this.now())
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.activePass = undefined;
        backgroundWorkSettled();
      });
  }
}
