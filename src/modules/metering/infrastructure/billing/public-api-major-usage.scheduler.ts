import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';

import { JitteredTimer } from '@/common/jittered-timer';
import type { PublicApiMajorUsageFlusher } from '@/modules/metering/application/billing/public-api-major-usage-flusher';

/** How often buffered counts reach the database, jittered per flush (#1869). */
export const PUBLIC_API_MAJOR_USAGE_FLUSH_INTERVAL_MS = 30_000;

/**
 * Flushes the process's buffered Public API major counts on a timer, and once
 * more before shutdown while the database is still open: that last pass waits
 * for one in flight and marks the clean stop. Disabled under test, where a
 * background write would land in a suite that is asserting on rows.
 */
export class PublicApiMajorUsageScheduler
  implements OnModuleInit, BeforeApplicationShutdown
{
  private readonly timer: JitteredTimer;

  constructor(
    private readonly flusher: PublicApiMajorUsageFlusher,
    private readonly enabled: boolean,
    intervalMs: number = PUBLIC_API_MAJOR_USAGE_FLUSH_INTERVAL_MS,
  ) {
    this.timer = new JitteredTimer(() => void this.flusher.flush(), intervalMs);
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.timer.stop();
    if (this.enabled) {
      await this.flusher.finish();
    }
  }
}
