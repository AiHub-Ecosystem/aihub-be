import type { UploadSessionSweep } from '@/modules/uploads/public';

const DELETION_CEILING = 2_000;

export interface SpeakingAudioUploadSweepSummary {
  readonly scanned: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly failed: number;
  readonly dryRun: boolean;
  /** The run would have deleted more than one run may; it deleted nothing. */
  readonly ceilingExceeded: boolean;
}

/** Speaking's retention sweep delegates pagination and deletion to the core. */
export class SpeakingAudioUploadSweep {
  constructor(private readonly core: UploadSessionSweep) {}

  async run(input: {
    readonly dryRun: boolean;
    readonly now: Date;
  }): Promise<SpeakingAudioUploadSweepSummary> {
    const summary = await this.core.run(input);
    return { ...summary, ceilingExceeded: this.core.ceilingExceeded };
  }
}

export { DELETION_CEILING };
