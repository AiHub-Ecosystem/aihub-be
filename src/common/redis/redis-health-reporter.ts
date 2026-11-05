import {
  type RedisProtectionSeam,
  recordRedisUnavailable,
} from '@/common/observability/redis-unavailable-metric';

interface LoggerLike {
  warn(fields: Record<string, unknown>): void;
  log(fields: Record<string, unknown>): void;
}

/**
 * One owner of the Redis degraded/recovered state transition (#1580): the
 * flag, the one log line per transition, and the unavailable metric.
 *
 * A failed command always counts the metric, so one alert covers every seam.
 * The warn and the recovered log fire once per state change, never per
 * request: at real RPS a per-request line floods the log without alerting on
 * anything more.
 */
export class RedisHealthReporter {
  private degraded = false;

  constructor(
    private readonly seam: RedisProtectionSeam,
    private readonly subject: string,
    private readonly logger: LoggerLike,
    /** Appended to the degraded line: the adapter's outage policy in one clause. */
    private readonly policy: string,
  ) {}

  /**
   * Records one failed command. The metric counts every call; the log only on
   * the healthy → degraded transition. The optional reason names why the
   * command failed — never a request identifier.
   */
  reportDegraded(reason?: unknown): void {
    recordRedisUnavailable(this.seam);
    if (this.degraded) return;

    this.degraded = true;
    const cause =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : undefined;
    this.logger.warn({
      event: 'redis_degraded',
      seam: this.seam,
      subject: this.subject,
      ...(cause === undefined ? {} : { reason: cause }),
      policy: this.policy,
    });
  }

  /** Logs on the degraded → healthy transition only. */
  reportRecovered(): void {
    if (!this.degraded) return;

    this.degraded = false;
    this.logger.log({
      event: 'redis_recovered',
      seam: this.seam,
      subject: this.subject,
    });
  }
}
