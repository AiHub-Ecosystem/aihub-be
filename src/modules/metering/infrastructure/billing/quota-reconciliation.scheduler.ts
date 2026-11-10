import {
  type BeforeApplicationShutdown,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';

import {
  JITTER_FRACTION,
  JitteredTimer,
  staggerMs,
} from '@/common/jittered-timer';
import { quotaPeriod } from '@/modules/metering/public/quota-counter';
import type { QuotaReconciliationService } from '@/modules/metering/public/quota-reconciliation';

export function nextQuotaReconciliationDelay(
  now: Date,
  intervalMs: number,
): number {
  const elapsed = now.getTime() - quotaPeriod(now).start.getTime();
  return intervalMs - (elapsed % intervalMs);
}

export class QuotaReconciliationScheduler
  implements OnModuleInit, BeforeApplicationShutdown
{
  private readonly logger = new Logger(QuotaReconciliationScheduler.name);
  private readonly timer: JitteredTimer;
  private running: Promise<void> | undefined;

  constructor(
    private readonly reconciliation: QuotaReconciliationService,
    private readonly intervalMs: number,
    private readonly driftThresholdAbs: number,
    private readonly driftThresholdFraction: number,
    private readonly enabled: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.timer = new JitteredTimer(
      () => void this.pass(),
      intervalMs,
      () => this.nextDelay(),
    );
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer.start(this.nextDelay());
  }

  /**
   * Each pass stays after its interval boundary, so a period rollover is still
   * reconciled right after it starts, but lands up to a tenth of the interval
   * past it, so replicas do not reconcile in the same instant (#1869).
   */
  private nextDelay(): number {
    return (
      nextQuotaReconciliationDelay(this.now(), this.intervalMs) +
      staggerMs(this.intervalMs * JITTER_FRACTION)
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.timer.stop();
    await this.running;
  }

  private async pass(): Promise<void> {
    if (this.running !== undefined) return;
    const running = this.reconcile();
    this.running = running;
    try {
      await running;
    } finally {
      this.running = undefined;
    }
  }

  private async reconcile(): Promise<void> {
    try {
      await this.reconciliation.reconcile(
        undefined,
        (event) => {
          if (event.type === 'drift_corrected') {
            this.logger.warn({
              event: 'quota_reconciliation_drift_corrected',
              organization_id: event.organizationId,
              month: event.month,
              postgres_count: event.postgresCount,
              redis_count: event.redisCount,
              drift_requests: event.driftRequests,
              threshold_requests: event.thresholdRequests,
            });
          }
        },
        {
          driftThresholdAbs: this.driftThresholdAbs,
          driftThresholdFraction: this.driftThresholdFraction,
        },
      );
    } catch {
      this.logger.error({ event: 'quota_reconciliation_failed' });
    }
  }
}
