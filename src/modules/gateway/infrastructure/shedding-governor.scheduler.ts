import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';

import { JitteredTimer } from '@/common/jittered-timer';
import { SheddingPolicy } from '@/modules/gateway/application/shedding/shedding-policy';
import type { DownstreamConcurrencySample } from './dispatch/downstream-concurrency-metrics';
import { setSheddingLevelMetric } from './dispatch/shedding-metrics';
import type { SheddingLevelStore } from './shedding-level.store';

/** Fast enough that a spike is shed within a request or two, cheap enough to run on every instance. */
const SAMPLE_INTERVAL_MS = 1_000;

/**
 * The highest `inFlight / limit` across origins: the one origin closest to
 * refusing work is what the host must not be pushed further past.
 */
function peakUtilization(
  samples: readonly DownstreamConcurrencySample[],
): number {
  return samples.reduce((peak, sample) => {
    const limit = sample.limit > 0 ? sample.limit : 0;
    const utilization = limit === 0 ? 0 : sample.inFlight / limit;
    return Math.max(peak, utilization);
  }, 0);
}

/**
 * Turns the adaptive concurrency limiter's saturation into a shedding level
 * (#1591, ADR-0173).
 *
 * The policy lives in the application layer and is pure; this timer only reads
 * the sample, folds it in, and writes the result where the request hook reads
 * it. The sample is local, so each instance decides from its own view of the
 * host; the shared level store makes the higher decision win across peers.
 */
export class SheddingGovernorScheduler
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly policy = new SheddingPolicy();
  private readonly timer: JitteredTimer;
  private readingSharedLevel = false;

  constructor(
    private readonly snapshot: () => readonly DownstreamConcurrencySample[],
    private readonly level: SheddingLevelStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.timer = new JitteredTimer(() => this.runPass(), SAMPLE_INTERVAL_MS);
  }

  onModuleInit(): void {
    this.timer.start(0);
  }

  onApplicationShutdown(): void {
    this.timer.stop();
  }

  /** One decision pass, exposed so a test can drive it without the timer. */
  runPass(): void {
    const next = this.policy.observe(
      peakUtilization(this.snapshot()),
      this.now(),
    );
    this.level.setLocal(next);
    // The gauge reports the level this instance applies, which is the higher of
    // its own decision and a peer's; a peer shedding alone must still show.
    setSheddingLevelMetric(this.level.current());
    this.readSharedLevel();
  }

  private readSharedLevel(): void {
    if (this.readingSharedLevel) return;
    this.readingSharedLevel = true;
    void this.level
      .refresh()
      // A peer's level raises what this instance applies, so the gauge moves
      // with the read rather than a pass later.
      .then(() => setSheddingLevelMetric(this.level.current()))
      .finally(() => {
        this.readingSharedLevel = false;
      });
  }
}
