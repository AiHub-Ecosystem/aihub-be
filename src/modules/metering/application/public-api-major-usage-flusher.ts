import type {
  PublicApiMajorUsageBuffer,
  PublicApiMajorUsageRepositoryPort,
} from './public-api-major-usage';

/**
 * Moves buffered counts into the database. A failed write puts the counts back
 * so the next pass retries them, and reports only a fixed message: the error
 * can carry connection details that must not reach a log.
 */
export class PublicApiMajorUsageFlusher {
  constructor(
    private readonly buffer: PublicApiMajorUsageBuffer,
    private readonly repository: PublicApiMajorUsageRepositoryPort,
    private readonly environment: string,
    private readonly report: (message: string) => void,
  ) {}

  async flush(): Promise<void> {
    const rows = this.buffer.drain();
    if (rows.length === 0) {
      return;
    }
    try {
      await this.repository.add(this.environment, rows);
    } catch {
      this.buffer.restore(rows);
      this.report('public API major usage flush failed');
    }
  }
}
