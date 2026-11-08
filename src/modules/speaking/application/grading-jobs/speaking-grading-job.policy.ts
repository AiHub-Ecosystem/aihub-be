/** Timing policy for Speaking grading jobs (ADR-0158 decision 6). */
export const SPEAKING_GRADING_JOB_POLICY = {
  /** How often the sweep runs. */
  sweepIntervalMs: 30_000,
  /** A job still `queued` this long after creation is re-enqueued. */
  reenqueueAfterMs: 60_000,
  /** A job still `queued` this long after creation ends `JOB_EXPIRED`. */
  queueExpiryMs: 15 * 60_000,
  /** How long a worker's claim holds before the sweep may return the job to `queued`. */
  claimLeaseMs: 2 * 60_000,
  /**
   * A dispatched job still `running` this long after its dispatch mark ends
   * `DISPATCH_INTERRUPTED`: the 60-second question-grading deadline plus margin.
   */
  dispatchInterruptedAfterMs: 2 * 60_000,
  /** Delay before a worker that found no Concurrency permit retries. */
  permitRetryDelayMs: 5_000,
  /** Jobs and their results are deleted this long after creation. */
  retentionMs: 30 * 24 * 60 * 60_000,
  /** Upper bound of rows one sweep step reads. */
  sweepBatchSize: 100,
} as const;
