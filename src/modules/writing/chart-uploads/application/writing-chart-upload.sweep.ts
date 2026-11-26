import type { UploadSessionSweep } from '@/modules/uploads/public';

export interface WritingChartUploadSweepSummary {
  readonly scanned: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly failed: number;
  readonly dryRun: boolean;
}

/** Writing's retention sweep is the shared core sweep with Writing's policy. */
export class WritingChartUploadSweep {
  constructor(private readonly core: UploadSessionSweep) {}

  run(input: {
    readonly dryRun: boolean;
    readonly now: Date;
  }): Promise<WritingChartUploadSweepSummary> {
    return this.core.run(input);
  }
}
