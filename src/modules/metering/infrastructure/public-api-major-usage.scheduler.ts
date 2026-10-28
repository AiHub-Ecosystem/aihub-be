import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';

import type { PublicApiMajorUsageFlusher } from '@/modules/metering/application/public-api-major-usage-flusher';

/** How often buffered counts reach the database. */
export const PUBLIC_API_MAJOR_USAGE_FLUSH_INTERVAL_MS = 30_000;

/**
 * Flushes the process's buffered Public API major counts on a timer, and once
 * more before shutdown while the database is still open. Disabled under test,
 * where a background write would land in a suite that is asserting on rows.
 */
export class PublicApiMajorUsageScheduler
  implements OnModuleInit, BeforeApplicationShutdown
{
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly flusher: PublicApiMajorUsageFlusher,
    private readonly enabled: boolean,
    private readonly intervalMs: number = PUBLIC_API_MAJOR_USAGE_FLUSH_INTERVAL_MS,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      void this.flusher.flush();
    }, this.intervalMs);
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.enabled) {
      await this.flusher.flush();
    }
  }
}
