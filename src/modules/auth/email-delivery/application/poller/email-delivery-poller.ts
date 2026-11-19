import type { EmailCredentialActionabilityPort } from '@/modules/auth/email-delivery/application/email-credential-actionability.port';
import type { EmailDeliveryRequestRecord } from '@/modules/auth/email-delivery/application/email-delivery-request.types';
import type { EmailDispatchPollerPort } from '@/modules/auth/email-delivery/application/email-dispatch-store.port';
import type { EmailPayloadCipherPort } from '@/modules/auth/email-delivery/application/email-payload-cipher.port';
import type { EmailProviderOutageCircuitPort } from '@/modules/auth/email-delivery/application/email-provider-outage-circuit.port';
import type { EmailSendRateLimiterPort } from '@/modules/auth/email-delivery/application/email-send-rate-limiter.port';
import {
  EMAIL_ATTEMPT_TIMEOUT_MS,
  type EmailSenderPort,
} from '@/modules/auth/email-delivery/application/email-sender.port';
import { claimEmailDeliveryBatch } from './email-delivery-poller-claim';
import {
  EmailDeliveryPollerDispatchSteps,
  EMAIL_SEND_RATE_LIMIT_RETRY_MS as dispatchRetryDelayMs,
} from './email-delivery-poller-dispatch-steps';
import { EmailDeliveryPollerMaintenance } from './email-delivery-poller-maintenance';
import type {
  EmailDeliveryPollerOptions,
  EmailDispatchOutcome,
} from './email-delivery-poller.types';
export { DEFER_RETRY_MS } from './email-delivery-poller-dispatch-steps';
export const EMAIL_SEND_RATE_LIMIT_RETRY_MS = dispatchRetryDelayMs;
export type { EmailDeliveryPollerOptions } from './email-delivery-poller.types';
export { MAX_CREDENTIAL_LIFETIME_MS } from './email-delivery-poller-maintenance';

export interface EmailDispatchSummary {
  readonly claimed: number;
  readonly providerAccepted: number;
  /** Includes requests cancelled because they outlived every credential. */
  readonly cancelled: number;
  /** Requests that exhausted their attempts; a retried one is not failed. */
  readonly failed: number;
  /** Requests handed back because this instance cannot open their payload. */
  readonly deferred: number;
}

/**
 * Dispatches queued Email Delivery Requests against the instance's own
 * database (ADR-0074). One pass claims a lease-protected batch and takes each
 * request as far as it can go: a request whose credential is no longer
 * actionable is cancelled rather than sent, a provider failure is retried on a
 * bounded schedule, and every terminal state leaves the store to erase the
 * payload.
 *
 * `now` is injected rather than read from the process clock so that the expiry
 * boundary and the retry schedule are decided by the time the caller controls.
 */
export class EmailDeliveryPoller {
  static readonly BATCH_SIZE = 10;
  static readonly ATTEMPT_TIMEOUT_MS = EMAIL_ATTEMPT_TIMEOUT_MS;
  /**
   * What one request costs besides its provider attempt: the credential check
   * that decides dispatch, the terminal write that records the outcome, and the
   * scheduling between them. The lease budget is spent per request, so it is
   * declared next to the attempt it adds to.
   *
   * This is an estimate, not a bound: nothing measures how long the two queries
   * around an attempt take, so a store slow enough to spend more than this
   * shortens the guarantee. Raise it when that shows up.
   */
  static readonly REQUEST_OVERHEAD_MS = 5_000;
  /**
   * A lease has to outlive the whole batch, not one request: a poller holds a
   * full batch of rows while it works through them, and a lease that expired
   * mid-batch would let a second instance re-claim a row this one is still
   * sending. It therefore carries margin past that worst case, because the
   * claim predicate treats a lapsed lease as immediately reclaimable.
   */
  static readonly LEASE_MARGIN_MS = 5_000;

  static leaseMsFor(batchSize: number): number {
    return (
      batchSize *
        (EmailDeliveryPoller.ATTEMPT_TIMEOUT_MS +
          EmailDeliveryPoller.REQUEST_OVERHEAD_MS) +
      EmailDeliveryPoller.LEASE_MARGIN_MS
    );
  }

  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly dispatchSteps: EmailDeliveryPollerDispatchSteps;
  private readonly maintenance: EmailDeliveryPollerMaintenance;

  constructor(
    private readonly store: EmailDispatchPollerPort,
    credentials: EmailCredentialActionabilityPort,
    cipher: EmailPayloadCipherPort,
    sender: EmailSenderPort,
    sendRateLimiter: EmailSendRateLimiterPort,
    providerOutageCircuit: EmailProviderOutageCircuitPort,
    private readonly now: () => Date,
    tokens: { hash(raw: string): string },
    private readonly options: EmailDeliveryPollerOptions,
  ) {
    this.batchSize = options.batchSize ?? EmailDeliveryPoller.BATCH_SIZE;
    this.leaseMs =
      options.leaseMs ?? EmailDeliveryPoller.leaseMsFor(this.batchSize);
    this.maintenance = new EmailDeliveryPollerMaintenance(
      store,
      now,
      options,
      this.batchSize,
      this.leaseMs,
    );
    this.dispatchSteps = new EmailDeliveryPollerDispatchSteps({
      store,
      credentials,
      cipher,
      sender,
      sendRateLimiter,
      providerOutageCircuit,
      now,
      tokens,
      options,
      maintenance: this.maintenance,
    });
  }

  async runOnce(
    input: { readonly requestIds?: readonly string[] } = {},
  ): Promise<EmailDispatchSummary> {
    const maintenance = await this.maintenance.reconcile();
    const claimAt = this.now();
    const claimed = await claimEmailDeliveryBatch(
      this.store,
      {
        owner: this.options.owner,
        limit: this.batchSize,
        leaseMs: this.leaseMs,
        now: claimAt,
        batchSize: this.batchSize,
        ...(input.requestIds === undefined ? {} : { ids: input.requestIds }),
      },
      this.maintenance.hasPendingAttemptReleases ||
        this.options.shouldStop?.() === true ||
        claimAt.getTime() < this.dispatchSteps.providerPausedUntil,
    );

    const summary = {
      claimed: claimed.length,
      providerAccepted: 0,
      cancelled: maintenance.cancelled,
      failed: maintenance.failed,
      deferred: 0,
    };
    let pauseBatch = false;
    for (const request of claimed) {
      // Shutdown hands the rest of the batch back, as an outage does: no
      // provider call starts after it begins (#833).
      if (this.options.shouldStop?.() === true) pauseBatch = true;
      if (pauseBatch) {
        const now = this.now();
        const retryAfterMs = Math.max(
          EMAIL_SEND_RATE_LIMIT_RETRY_MS,
          this.dispatchSteps.providerPausedUntil - now.getTime(),
        );
        try {
          await this.maintenance.defer(request, now, retryAfterMs);
          summary.deferred += 1;
        } catch {
          // Its lease lapses if the store cannot hand it back.
        }
        continue;
      }
      try {
        const outcome = await this.dispatch(request);
        if (outcome === 'provider_accepted') summary.providerAccepted += 1;
        if (outcome === 'cancelled') summary.cancelled += 1;
        if (outcome === 'failed') summary.failed += 1;
        if (outcome === 'deferred') summary.deferred += 1;
        if (outcome === 'provider_outage') {
          summary.deferred += 1;
          pauseBatch = true;
        }
        if (outcome === 'configuration_failure') {
          summary.deferred += 1;
          pauseBatch = true;
        }
      } catch {
        // The store is unreachable, or a transition lost a race with another
        // instance. The row keeps its lease and its payload, so the next pass
        // picks it up again; swallowing here is what keeps one bad row from
        // stranding the rest of the batch.
        if (this.now().getTime() < this.dispatchSteps.providerPausedUntil)
          pauseBatch = true;
      }
    }
    await this.maintenance.reportUnreportedFailures();
    return summary;
  }

  async reconcile(): Promise<{
    readonly cancelled: number;
    readonly failed: number;
  }> {
    const result = await this.maintenance.reconcile();
    await this.maintenance.reportUnreportedFailures();
    return result;
  }

  private async dispatch(
    request: EmailDeliveryRequestRecord,
  ): Promise<EmailDispatchOutcome> {
    const now = this.now();
    const delivery = await this.dispatchSteps.readPayload({ request, now });
    if (typeof delivery === 'string') return delivery;

    const credential = delivery.credential();
    const credentialOutcome =
      await this.dispatchSteps.checkCredentialActionability({
        request,
        credential,
        now,
      });
    if (credentialOutcome !== undefined) return credentialOutcome;

    const message = await this.dispatchSteps.renderMessage({ delivery, now });
    if (message === undefined)
      return this.maintenance.cancel(request, 'not_actionable', now);

    const sendResult = await this.dispatchSteps.reserveProviderSend({
      request,
      delivery,
      credential,
      message,
      now,
    });
    if (typeof sendResult === 'string') return sendResult;

    return this.dispatchSteps.translateProviderOutcome({
      request,
      ...sendResult,
      attemptedAt: now,
    });
  }
}
