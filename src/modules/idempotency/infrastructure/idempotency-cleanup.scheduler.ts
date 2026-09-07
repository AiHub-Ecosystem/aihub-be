import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  IDEMPOTENCY_REPOSITORY,
  type IdempotencyRepositoryPort,
} from '../application/idempotency-repository.port';

export const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

@Injectable()
export class IdempotencyCleanupScheduler {
  private readonly logger = new Logger(IdempotencyCleanupScheduler.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(IDEMPOTENCY_REPOSITORY)
    private readonly repository: IdempotencyRepositoryPort,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.cleanup();
    }, IDEMPOTENCY_CLEANUP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer === undefined) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async cleanup(): Promise<void> {
    try {
      await this.repository.cleanupExpired();
    } catch {
      this.logger.warn('Idempotency cleanup failed');
    }
  }
}
