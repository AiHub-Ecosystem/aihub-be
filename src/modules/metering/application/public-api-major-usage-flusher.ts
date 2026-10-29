import type {
  PublicApiMajorCollector,
  PublicApiMajorUsageBuffer,
  PublicApiMajorUsageRepositoryPort,
} from './public-api-major-usage';

/** How long shutdown waits for the last write before giving up on it. */
export const PUBLIC_API_MAJOR_FINAL_FLUSH_TIMEOUT_MS = 10_000;

/**
 * Moves buffered counts into the database. A failed write puts the counts back
 * so the next pass retries them, and reports only a fixed message: the error
 * can carry connection details that must not reach a log.
 *
 * Every pass writes, even with nothing buffered, because the write also
 * extends this process's collection record: a process that stops writing is
 * how a gap in the counts becomes visible to the adoption report (#1389).
 */
export class PublicApiMajorUsageFlusher {
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly buffer: PublicApiMajorUsageBuffer,
    private readonly repository: PublicApiMajorUsageRepositoryPort,
    private readonly environment: string,
    private readonly collector: PublicApiMajorCollector,
    private readonly report: (message: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A periodic pass. Skipped while the previous one is still writing. */
  async flush(): Promise<void> {
    if (this.inFlight !== undefined) {
      return;
    }
    await this.write(false);
  }

  /**
   * The last pass before shutdown: waits for one in flight, then writes the
   * remaining counts and marks the clean stop, bounded so a stuck database
   * cannot hold shutdown. A last write that fails or times out leaves the
   * process recorded as an unclean exit, which the report shows.
   */
  async finish(
    timeoutMs: number = PUBLIC_API_MAJOR_FINAL_FLUSH_TIMEOUT_MS,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.report('public API major usage final flush timed out');
        resolve();
      }, timeoutMs);
    });
    const last = (async (): Promise<void> => {
      await this.inFlight;
      await this.write(true);
    })();
    try {
      await Promise.race([last, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private write(stoppedCleanly: boolean): Promise<void> {
    const pass = (async (): Promise<void> => {
      const batch = this.buffer.drain();
      try {
        await this.repository.add(this.environment, {
          ...batch,
          collector: this.collector,
          coveredThrough: this.now(),
          stoppedCleanly,
        });
      } catch {
        this.buffer.restore(batch);
        this.report('public API major usage flush failed');
      }
    })();
    this.inFlight = pass;
    void pass.finally(() => {
      if (this.inFlight === pass) {
        this.inFlight = undefined;
      }
    });
    return pass;
  }
}
