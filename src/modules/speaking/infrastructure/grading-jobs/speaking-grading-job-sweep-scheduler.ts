import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';

import {
  backgroundWorkSettled,
  backgroundWorkStarted,
} from '@/common/background-work-tracker';
import { JitteredTimer } from '@/common/jittered-timer';
import { SPEAKING_GRADING_JOB_POLICY } from '@/modules/speaking/application/grading-jobs/speaking-grading-job.policy';
import type { SpeakingGradingJobSweep } from '@/modules/speaking/application/grading-jobs/speaking-grading-job.sweep';

/** Runs one in-process sweep around the accepted policy interval, jittered (#1869), and joins shutdown draining. */
export class SpeakingGradingJobSweepScheduler
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly timer: JitteredTimer;
  private activePass: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly sweep: Pick<SpeakingGradingJobSweep, 'run'>,
    private readonly now: () => Date = () => new Date(),
    intervalMs: number = SPEAKING_GRADING_JOB_POLICY.sweepIntervalMs,
  ) {
    this.timer = new JitteredTimer(() => this.runPass(), intervalMs);
  }

  onModuleInit(): void {
    this.timer.start();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.timer.stop();
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
