import {
  type BeforeApplicationShutdown,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';

import { quotaPeriod } from '@/modules/gateway/public/quota-period';
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
  private initialTimer: NodeJS.Timeout | undefined;
  private intervalTimer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly reconciliation: QuotaReconciliationService,
    private readonly intervalMs: number,
    private readonly driftThresholdAbs: number,
    private readonly driftThresholdFraction: number,
    private readonly enabled: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  onModuleInit(): void {
    if (!this.enabled) return;
    this.initialTimer = setTimeout(
      () => {
        this.initialTimer = undefined;
        void this.pass();
        this.intervalTimer = setInterval(
          () => void this.pass(),
          this.intervalMs,
        );
        this.intervalTimer.unref();
      },
      nextQuotaReconciliationDelay(this.now(), this.intervalMs),
    );
    this.initialTimer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.initialTimer !== undefined) clearTimeout(this.initialTimer);
    if (this.intervalTimer !== undefined) clearInterval(this.intervalTimer);
    this.initialTimer = undefined;
    this.intervalTimer = undefined;
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
