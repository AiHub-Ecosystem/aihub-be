import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import {
  type EmailDeliveryKindLabel,
  recordEmailDeliveryFailed,
} from '@/common/observability/metrics';
import { EmailDeliveryPoller } from '@/modules/auth/application/email-delivery-poller';

/** How often an instance looks for work. The lease, not this, bounds overlap. */
export const EMAIL_OUTBOX_POLL_INTERVAL_MS = 5_000;

/**
 * Runs the poller in this instance, against this instance's own database
 * (ADR-0074). There is no separate worker container: every process that serves
 * requests also serves the outbox, and the database lease is what keeps two of
 * them off the same row.
 *
 * Disabled under test, where a background pass would dispatch rows another
 * suite is asserting on. That is the one condition that stops it: an instance
 * that forgets to run would leave accepted mail unsent, so the default is on.
 */
@Injectable()
export class EmailOutboxPollerScheduler
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(EmailOutboxPollerScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly poller: EmailDeliveryPoller,
    private readonly intervalMs = EMAIL_OUTBOX_POLL_INTERVAL_MS,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.pass();
    }, this.intervalMs);
    // A pending claim must not hold the process open on shutdown; the lease
    // releases it once it lapses.
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One pass, skipped while an earlier one is still running. A batch can take
   * longer than the interval, and stacking passes would claim rows this instance
   * is already sending.
   */
  private async pass(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await this.poller.runOnce();
      if (summary.claimed > 0) {
        this.logger.log(
          `email outbox pass claimed=${summary.claimed} provider_accepted=${summary.providerAccepted} cancelled=${summary.cancelled} failed=${summary.failed}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `email outbox pass failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }
}

/**
 * A terminal failure is the one outbox event that pages, so it emits a metric
 * and a structured log line — and neither carries a recipient address, a token,
 * a message body, or anything the provider said in response.
 */
export function reportTerminalEmailDeliveryFailure(failure: {
  readonly id: string;
  readonly kind: EmailDeliveryKindLabel;
  readonly errorCode: string;
}): void {
  recordEmailDeliveryFailed(failure.kind);
  new Logger('EmailOutboxDispatch').error(
    `email delivery request ${failure.id} exhausted its attempts kind=${failure.kind} error=${failure.errorCode}`,
  );
}

/** Distinguishes two instances of the same deployment in the lease column. */
export function emailOutboxLeaseOwner(): string {
  return `outbox-${randomUUID()}`;
}
