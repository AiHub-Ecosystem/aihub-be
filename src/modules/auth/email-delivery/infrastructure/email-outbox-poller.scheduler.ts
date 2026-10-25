import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import {
  backgroundWorkSettled,
  backgroundWorkStarted,
  isShuttingDown,
} from '@/common/http/background-work-drain';
import {
  type EmailDeliveryKindLabel,
  type EmailOutboxBacklogSample,
  type EmailOutboxCancellationSample,
  recordEmailDeliveryFailed,
  setEmailDailySendBudgetSource,
  setEmailOutboxBacklogSource,
  setEmailOutboxCancellationSource,
  setEmailProviderOutageDurationSource,
} from '@/common/observability/metrics';
import { EmailDeliveryPoller } from '@/modules/auth/email-delivery/application/email-delivery-poller';
import { RetiredKeyVersionLiveError } from './auth-email-recipient-limit';

/** How often an instance looks for work. The lease, not this, bounds overlap. */
export const EMAIL_OUTBOX_POLL_INTERVAL_MS = 5_000;
export const AUTH_EMAIL_RECIPIENT_LIMIT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

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
  private cleanupTimer: NodeJS.Timeout | undefined;
  private running = false;
  private pruning = false;
  private recipientKeyGatePassed = false;
  private recipientKeyGateReported = false;

  /**
   * `backlog` feeds the queue-age gauges. It is registered beside the timer
   * rather than read by the poller, so the gauges keep reporting from the table
   * even when passes stop running — which is the outage they exist to show.
   */
  constructor(
    private readonly poller: EmailDeliveryPoller,
    private readonly intervalMs = EMAIL_OUTBOX_POLL_INTERVAL_MS,
    private readonly backlog?: () => Promise<
      readonly EmailOutboxBacklogSample[]
    >,
    private readonly enabled = true,
    private readonly pruneExpiredRecipientLimits?: () => Promise<number>,
    private readonly cancellations?: () => Promise<
      readonly EmailOutboxCancellationSample[]
    >,
    private readonly dailyBudget?: () => Promise<{
      readonly used: number;
      readonly limit: number;
    }>,
    private readonly providerOutageDuration?: () => Promise<number>,
    private readonly verifyRecipientKeyVersions?: () => Promise<void>,
    private readonly readMissingQueuedKeyVersions?: () => Promise<
      readonly string[]
    >,
  ) {}

  /**
   * The keyring retention check runs before any timer starts: a keyring that
   * dropped a version with live recipient windows refuses the boot instead of
   * silently resetting every ceiling under it (#1130). Nest awaits this hook,
   * so its rejection fails startup. A counter table that cannot be read - the
   * image-boot contract boots without a database - defers the verdict instead:
   * the gate retries before every pass, and no pass runs until it resolves,
   * so the ceiling is never reset either way.
   */
  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    if (this.backlog !== undefined) {
      setEmailOutboxBacklogSource(this.backlog);
    }
    if (this.cancellations !== undefined) {
      setEmailOutboxCancellationSource(this.cancellations);
    }
    if (this.dailyBudget !== undefined) {
      setEmailDailySendBudgetSource(this.dailyBudget);
    }
    if (this.providerOutageDuration !== undefined) {
      setEmailProviderOutageDurationSource(this.providerOutageDuration);
    }
    await this.reportMissingQueuedKeyVersions();
    await this.runRecipientKeyGate(true);
    this.timer = setInterval(() => {
      void this.pass();
    }, this.intervalMs);
    if (this.pruneExpiredRecipientLimits !== undefined) {
      void this.pruneExpiredRecipientCounters();
      this.cleanupTimer = setInterval(() => {
        void this.pruneExpiredRecipientCounters();
      }, AUTH_EMAIL_RECIPIENT_LIMIT_CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref();
    }
    // A pending claim must not hold the process open on shutdown; the lease
    // releases it once it lapses.
    this.timer.unref();
  }

  /**
   * Runs the keyring gate once it has not passed. A confirmed retired version
   * refuses the boot when `booting`; afterwards it keeps every pass held with
   * one error line, and the queue-age alert is what carries it to an operator.
   * Any other failure means the counter table could not be read, and the gate
   * simply stays unresolved until a pass tick can read it.
   */
  private async runRecipientKeyGate(booting: boolean): Promise<boolean> {
    if (
      this.verifyRecipientKeyVersions === undefined ||
      this.recipientKeyGatePassed
    ) {
      return true;
    }
    try {
      await this.verifyRecipientKeyVersions();
      this.recipientKeyGatePassed = true;
      return true;
    } catch (error) {
      if (booting && error instanceof RetiredKeyVersionLiveError) {
        throw error;
      }
      if (!this.recipientKeyGateReported) {
        this.recipientKeyGateReported = true;
        this.logger.error(
          `email outbox keyring gate not passed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      return false;
    }
  }

  private async reportMissingQueuedKeyVersions(): Promise<void> {
    if (this.readMissingQueuedKeyVersions === undefined) return;
    try {
      const versions = await this.readMissingQueuedKeyVersions();
      if (versions.length > 0) {
        this.logger.error(
          `email outbox queued requests reference unavailable key versions: ${versions.join(',')}`,
        );
      }
    } catch {
      this.logger.error('email outbox queued key version check failed');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    if (this.backlog !== undefined) {
      setEmailOutboxBacklogSource(undefined);
    }
    if (this.cancellations !== undefined) {
      setEmailOutboxCancellationSource(undefined);
    }
    if (this.dailyBudget !== undefined) {
      setEmailDailySendBudgetSource(undefined);
    }
    if (this.providerOutageDuration !== undefined) {
      setEmailProviderOutageDurationSource(undefined);
    }
  }

  /**
   * One pass, skipped while an earlier one is still running. A batch can take
   * longer than the interval, and stacking passes would claim rows this instance
   * is already sending.
   *
   * A pass is background work: closing the server waits for it, within the
   * shutdown drain, before any connection it uses is closed. None starts once
   * shutdown has begun (#833).
   */
  private async pass(): Promise<void> {
    if (this.running || isShuttingDown()) return;
    if (!(await this.runRecipientKeyGate(false))) return;
    this.running = true;
    backgroundWorkStarted();
    try {
      const summary = await this.poller.runOnce();
      if (summary.claimed > 0 || summary.cancelled > 0 || summary.failed > 0) {
        this.logger.log(
          `email outbox pass claimed=${summary.claimed} provider_accepted=${summary.providerAccepted} cancelled=${summary.cancelled} failed=${summary.failed} deferred=${summary.deferred}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `email outbox pass failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
      backgroundWorkSettled();
    }
  }

  /**
   * The hourly cleanup of expired recipient counters, guarded like a pass:
   * none starts once shutdown has begun, and one already running joins the
   * background-work drain, so the pool is never closed under its DELETE
   * (#1134).
   */
  private async pruneExpiredRecipientCounters(): Promise<void> {
    if (this.pruning || isShuttingDown()) return;
    this.pruning = true;
    backgroundWorkStarted();
    try {
      await this.pruneExpiredRecipientLimits?.();
    } catch {
      this.logger.error(
        'authentication email recipient counter cleanup failed',
      );
    } finally {
      this.pruning = false;
      backgroundWorkSettled();
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

/** Emits one bounded signal when the provider rejects its configured credentials. */
export function reportEmailProviderConfigurationFailure(failure: {
  readonly status: 401 | 403;
}): void {
  new Logger('EmailOutboxDispatch').error(
    `email provider credentials rejected status=${failure.status}; dispatch paused`,
  );
}

/** Distinguishes two instances of the same deployment in the lease column. */
export function emailOutboxLeaseOwner(): string {
  return `outbox-${randomUUID()}`;
}
