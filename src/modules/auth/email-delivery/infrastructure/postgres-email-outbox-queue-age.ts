import type { EmailDeliveryKind } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { EmailOutboxQueueAgePort } from '@/modules/auth/email-delivery/application/email-outbox-backpressure.port';
import type { EmailDeliveryBacklogRow } from './postgres-email-delivery-request.repository';

/** How long one read of the queue serves every request that arrives meanwhile. */
export const QUEUE_AGE_CACHE_MS = 10_000;

interface BacklogReader {
  backlog(input: { now: Date }): Promise<readonly EmailDeliveryBacklogRow[]>;
}

/**
 * The oldest queued request per kind, from the same query the queue-age gauge
 * reads. One read is shared by the requests of a short window, so admission
 * costs the sign-up path no query of its own at steady load; a failed read is
 * never cached and surfaces to the gate, which admits.
 */
export class PostgresEmailOutboxQueueAge implements EmailOutboxQueueAgePort {
  private cached:
    | {
        readonly readAt: number;
        readonly rows: readonly EmailDeliveryBacklogRow[];
      }
    | undefined;
  private pending: Promise<readonly EmailDeliveryBacklogRow[]> | undefined;

  constructor(
    private readonly store: BacklogReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async oldestQueuedAgeSeconds(
    kind: EmailDeliveryKind,
  ): Promise<number | undefined> {
    const rows = await this.read();
    return rows.find((candidate) => candidate.kind === kind)?.oldestAgeSeconds;
  }

  private async read(): Promise<readonly EmailDeliveryBacklogRow[]> {
    const now = this.now();
    if (
      this.cached !== undefined &&
      now.getTime() - this.cached.readAt < QUEUE_AGE_CACHE_MS
    ) {
      return this.cached.rows;
    }
    this.pending ??= this.store
      .backlog({ now })
      .then((rows) => {
        this.cached = { readAt: now.getTime(), rows };
        return rows;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
