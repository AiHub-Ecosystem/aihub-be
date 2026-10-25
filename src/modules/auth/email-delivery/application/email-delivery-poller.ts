import { readEmailPayload } from './email-delivery-payload.reader';
import { EmailDeliveryPollerMaintenance } from './email-delivery-poller-maintenance';
import type { EmailDeliveryPollerMaintenanceOptions } from './email-delivery-poller-maintenance';
import type {
  EmailCredentialActionabilityPort,
  EmailCredentialState,
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
  EmailDeliveryRequestRecord,
  EmailDispatchStorePort,
  EmailNoticeResolvers,
} from './email-delivery-request.port';
import type { EmailPayloadCipherPort } from './email-delivery-request.port';
import type { ValidatedEmailDelivery } from './email-kind-handler.registry';
export { MAX_CREDENTIAL_LIFETIME_MS } from './email-delivery-poller-maintenance';
import type {
  EmailProviderOutageCircuitPort,
  EmailProviderSendPermit,
} from './email-provider-outage-circuit.port';
import { emailProviderRetryAfterMs } from './email-provider-retry-after.policy';
import { emailDailySendBudgetCategory } from './email-send-daily-budget.policy';
import type { EmailDailySendBudgetPort } from './email-send-daily-budget.port';
import type { EmailSendRateLimiterPort } from './email-send-rate-limiter.port';
import { EMAIL_ATTEMPT_TIMEOUT_MS } from './email-sender.port';
import type {
  EmailMessage,
  EmailProviderResponse,
  EmailSenderPort,
} from './email-sender.port';
import { EmailProviderTransportError } from './email-sender.port';

/**
 * How long a request this instance could not open waits before any instance
 * claims it again. Long enough that a batch is never filled by the same
 * unopenable rows pass after pass, short enough that an instance holding the
 * key picks it up well inside the credential's lifetime.
 */
export const DEFER_RETRY_MS = 5 * 60_000;

/** Retry a reservation outage on the next poll pass without spending an attempt. */
export const EMAIL_SEND_RATE_LIMIT_RETRY_MS = 5_000;

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

export interface EmailDeliveryPollerOptions
  extends EmailDeliveryPollerMaintenanceOptions {
  /** Validated by the Auth composition root; unset deployments use token-only copy. */
  readonly customerWebBaseUrl?: string;
  /** Filled by the modules that own a notice's facts; see the port. */
  readonly notices?: EmailNoticeResolvers;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  /** True once shutdown has begun: no claim, and no provider call, after it. */
  readonly shouldStop?: () => boolean;
  /** One safe signal per credential outage, reset by the next accepted send. */
  readonly onProviderConfigurationFailure?: (failure: {
    readonly status: 401 | 403;
  }) => void;
  /** Runtime dispatch supplies the shared durable account budget. */
  readonly dailySendBudget?: EmailDailySendBudgetPort;
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'TimeoutError'
  );
}

/**
 * Transport errors get one bounded code. HTTP rejection classes are mapped
 * from response metadata separately; provider details stay in the adapter.
 */
function errorCodeOf(error: unknown): EmailDeliveryErrorCode {
  return isTimeout(error) ? 'timeout' : 'provider_rejected';
}

function isCredentialExpired(expiresAt: string, at: Date): boolean {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= at.getTime();
}

function cancelReasonOf(
  state: Exclude<EmailCredentialState, 'actionable'>,
): EmailDeliveryCancelReason {
  return state === 'expired' ? 'credential_expired' : 'not_actionable';
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
  private providerPausedUntil = 0;
  private providerConfigurationAlerted = false;
  private readonly maintenance: EmailDeliveryPollerMaintenance;

  constructor(
    private readonly store: EmailDispatchStorePort,
    private readonly credentials: EmailCredentialActionabilityPort,
    private readonly cipher: EmailPayloadCipherPort,
    private readonly sender: EmailSenderPort,
    private readonly sendRateLimiter: EmailSendRateLimiterPort,
    private readonly providerOutageCircuit: EmailProviderOutageCircuitPort,
    private readonly now: () => Date,
    private readonly tokens: { hash(raw: string): string },
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
  }

  async runOnce(): Promise<EmailDispatchSummary> {
    const maintenance = await this.maintenance.reconcile();
    const claimAt = this.now();
    const claimed =
      this.maintenance.hasPendingAttemptReleases ||
      this.options.shouldStop?.() === true ||
      claimAt.getTime() < this.providerPausedUntil
        ? []
        : await this.store.claim({
            owner: this.options.owner,
            limit: this.batchSize,
            leaseMs: this.leaseMs,
            now: claimAt,
          });

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
          this.providerPausedUntil - now.getTime(),
        );
        try {
          await this.defer(request, now, retryAfterMs);
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
        if (this.now().getTime() < this.providerPausedUntil) pauseBatch = true;
      }
    }
    await this.maintenance.reportUnreportedFailures();
    return summary;
  }

  private async dispatch(
    request: EmailDeliveryRequestRecord,
  ): Promise<
    | 'provider_accepted'
    | 'cancelled'
    | 'failed'
    | 'retried'
    | 'deferred'
    | 'provider_outage'
    | 'configuration_failure'
  > {
    const now = this.now();
    let delivery:
      | ValidatedEmailDelivery
      | 'key_unavailable'
      | 'unreadable'
      | undefined;
    try {
      delivery = readEmailPayload(this.cipher, request);
    } catch {
      return this.defer(request, now);
    }
    if (delivery === 'unreadable' || delivery === 'key_unavailable') {
      // A missing key must be restored before this pass; after it is claimed,
      // fail durably so the erased payload cannot sit in the queue unnoticed.
      await this.store.markFailed({
        id: request.id,
        failedAt: now,
        errorCode:
          delivery === 'key_unavailable'
            ? 'key_unavailable'
            : 'payload_unreadable',
        owner: this.options.owner,
      });
      return 'failed';
    }
    if (delivery === undefined) {
      // Nothing was left to send: the payload was erased before it was claimed.
      return this.maintenance.cancel(request, 'not_actionable', now);
    }

    const credential = delivery.handler.credential(delivery.payload);
    if (credential !== undefined) {
      if (isCredentialExpired(credential.expiresAt, now)) {
        return this.maintenance.cancel(request, 'credential_expired', now);
      }

      const state = await this.credentials.check({
        kind: request.kind,
        tokenHash: this.tokens.hash(credential.token),
        now,
      });
      if (state !== 'actionable') {
        return this.maintenance.cancel(request, cancelReasonOf(state), now);
      }
    }

    // Rendered before anything is reserved, because a notice that reads its
    // facts now can find nothing left to send.
    const message = await delivery.handler.render(delivery.payload, {
      ...(this.options.customerWebBaseUrl === undefined
        ? {}
        : { customerWebBaseUrl: this.options.customerWebBaseUrl }),
      now,
      notices: this.options.notices ?? {},
    });
    if (message === undefined) {
      return this.maintenance.cancel(request, 'not_actionable', now);
    }

    let sendPermit: EmailProviderSendPermit;
    try {
      sendPermit = await this.providerOutageCircuit.acquireSendPermit();
    } catch {
      return this.deferForProviderOutage(
        request,
        now,
        EMAIL_SEND_RATE_LIMIT_RETRY_MS,
      );
    }
    if (!sendPermit.allowed) {
      return this.deferForProviderOutage(request, now, sendPermit.retryAfterMs);
    }

    // The attempt is spent before the provider is called, not recorded after it
    // answers: a transition that fails must not hand the same request another
    // pass at the provider.
    let reservation;
    try {
      reservation = await this.sendRateLimiter.reserve();
    } catch {
      await this.releaseProbe(sendPermit.probeToken);
      return this.defer(request, now, EMAIL_SEND_RATE_LIMIT_RETRY_MS);
    }
    if (!reservation.reserved) {
      await this.releaseProbe(sendPermit.probeToken);
      const retryAfterMs = reservation.retryAfterMs;
      return this.defer(
        request,
        now,
        Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
          ? retryAfterMs
          : EMAIL_SEND_RATE_LIMIT_RETRY_MS,
      );
    }

    if (this.options.dailySendBudget !== undefined) {
      let budgetReservation;
      try {
        budgetReservation = await this.options.dailySendBudget.reserve(
          emailDailySendBudgetCategory(request.kind),
        );
      } catch {
        await this.releaseProbe(sendPermit.probeToken);
        return this.defer(request, now, EMAIL_SEND_RATE_LIMIT_RETRY_MS);
      }
      if (!budgetReservation.reserved) {
        await this.releaseProbe(sendPermit.probeToken);
        const expiresAt = delivery.handler.credential(
          delivery.payload,
        )?.expiresAt;
        const remainingCredentialLifetime =
          expiresAt === undefined
            ? Infinity
            : Date.parse(expiresAt) - now.getTime();
        return this.defer(
          request,
          now,
          Number.isFinite(remainingCredentialLifetime) &&
            remainingCredentialLifetime > 0
            ? Math.min(
                budgetReservation.retryAfterMs,
                remainingCredentialLifetime,
              )
            : budgetReservation.retryAfterMs,
        );
      }
    }

    try {
      await this.store.reserveAttempt({
        id: request.id,
        attemptedAt: now,
        owner: this.options.owner,
      });
    } catch (error) {
      await this.releaseProbe(sendPermit.probeToken);
      throw error;
    }

    // The waits above can outlast the credential; this is the last check
    // before the provider call, not a promise about a concurrent revocation.
    const handoffAt = this.now();
    if (
      credential !== undefined &&
      isCredentialExpired(credential.expiresAt, handoffAt)
    ) {
      await this.releaseProbe(sendPermit.probeToken);
      return this.maintenance.cancel(request, 'credential_expired', handoffAt);
    }

    let response: EmailProviderResponse;
    try {
      response = await this.deliver(request, message);
    } catch (error) {
      if (error instanceof EmailProviderTransportError) {
        const failedAt = this.now();
        const retryAfterMs = await this.openProviderCircuit(
          0,
          failedAt,
          sendPermit.probeToken,
        );
        await this.maintenance.releaseUnspentAttempt(
          request,
          new Date(failedAt.getTime() + retryAfterMs),
        );
        return 'provider_outage';
      }
      await this.releaseProbe(sendPermit.probeToken);
      return this.maintenance.recordFailure(request, errorCodeOf(error), now);
    }

    const responseReceivedAt = this.now();

    if (response.status === 429) {
      const retryAfterMs = emailProviderRetryAfterMs(
        response.retryAfter,
        responseReceivedAt,
      );
      const circuitDelayMs = await this.openProviderCircuit(
        retryAfterMs,
        responseReceivedAt,
        sendPermit.probeToken,
      );
      await this.maintenance.releaseUnspentAttempt(
        request,
        new Date(
          responseReceivedAt.getTime() + Math.max(retryAfterMs, circuitDelayMs),
        ),
      );
      return 'provider_outage';
    }

    if (response.status >= 500 && response.status < 600) {
      const retryAfterMs = await this.openProviderCircuit(
        0,
        responseReceivedAt,
        sendPermit.probeToken,
      );
      await this.maintenance.releaseUnspentAttempt(
        request,
        new Date(responseReceivedAt.getTime() + retryAfterMs),
      );
      return 'provider_outage';
    }

    await this.closeProviderCircuit(sendPermit.probeToken);

    if (response.status === 401 || response.status === 403) {
      this.providerPausedUntil = responseReceivedAt.getTime() + DEFER_RETRY_MS;
      this.reportProviderConfigurationFailure(response.status);
      await this.maintenance.releaseUnspentAttempt(
        request,
        new Date(this.providerPausedUntil),
      );
      return 'configuration_failure';
    }

    if (response.status === 400 || response.status === 422) {
      await this.store.markFailed({
        id: request.id,
        failedAt: now,
        errorCode: 'provider_permanent_rejection',
        owner: this.options.owner,
      });
      return 'failed';
    }

    if (response.status < 200 || response.status >= 300) {
      return this.maintenance.recordFailure(request, 'provider_rejected', now);
    }

    await this.store.markProviderAccepted({
      id: request.id,
      attemptedAt: now,
      owner: this.options.owner,
    });
    this.providerConfigurationAlerted = false;
    return 'provider_accepted';
  }

  private async defer(
    request: EmailDeliveryRequestRecord,
    now: Date,
    retryAfterMs = DEFER_RETRY_MS,
  ): Promise<'deferred'> {
    await this.store.releaseDeferred({
      id: request.id,
      owner: this.options.owner,
      retryAt: new Date(now.getTime() + retryAfterMs),
    });
    return 'deferred';
  }

  private async deferForProviderOutage(
    request: EmailDeliveryRequestRecord,
    now: Date,
    retryAfterMs: number,
  ): Promise<'provider_outage'> {
    const safeRetryAfterMs =
      Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : EMAIL_SEND_RATE_LIMIT_RETRY_MS;
    this.providerPausedUntil = Math.max(
      this.providerPausedUntil,
      now.getTime() + safeRetryAfterMs,
    );
    await this.defer(
      request,
      now,
      Math.max(EMAIL_SEND_RATE_LIMIT_RETRY_MS, safeRetryAfterMs),
    );
    return 'provider_outage';
  }

  private async releaseProbe(probeToken: string | undefined): Promise<void> {
    if (probeToken === undefined) return;
    try {
      await this.providerOutageCircuit.releaseProbe(probeToken);
    } catch {
      // Redis expires the probe lock with its bounded recovery TTL, and the
      // acquire script takes over a probe held past its stale margin (#1113).
    }
  }

  private async openProviderCircuit(
    retryAfterMs: number,
    openedAt: Date,
    probeToken?: string,
  ): Promise<number> {
    try {
      const circuitDelayMs =
        await this.providerOutageCircuit.recordProviderFailure(
          retryAfterMs,
          probeToken,
        );
      const safeDelayMs =
        Number.isSafeInteger(circuitDelayMs) && circuitDelayMs >= 0
          ? Math.max(retryAfterMs, circuitDelayMs)
          : Math.max(retryAfterMs, EMAIL_SEND_RATE_LIMIT_RETRY_MS);
      this.providerPausedUntil = Math.max(
        this.providerPausedUntil,
        openedAt.getTime() + safeDelayMs,
      );
      return safeDelayMs;
    } catch {
      // Nothing reached shared state, so the probe this attempt held would
      // strand every poller until the outage key expires (#1113).
      await this.releaseProbe(probeToken);
      const fallbackDelayMs = Math.max(
        retryAfterMs,
        EMAIL_SEND_RATE_LIMIT_RETRY_MS,
      );
      this.providerPausedUntil = Math.max(
        this.providerPausedUntil,
        openedAt.getTime() + fallbackDelayMs,
      );
      return fallbackDelayMs;
    }
  }

  private async closeProviderCircuit(probeToken?: string): Promise<void> {
    try {
      await this.providerOutageCircuit.recordProviderReachable();
    } catch {
      // The state this DEL failed to clear still holds the probe, and a held
      // probe strands every poller until it is released or taken over (#1113).
      await this.releaseProbe(probeToken);
      this.providerPausedUntil = Math.max(
        this.providerPausedUntil,
        this.now().getTime() + EMAIL_SEND_RATE_LIMIT_RETRY_MS,
      );
    }
  }

  private async deliver(
    request: EmailDeliveryRequestRecord,
    message: EmailMessage,
  ): Promise<EmailProviderResponse> {
    // The row's own id is the provider idempotency key: it is already unique,
    // already durable, and already what every attempt of this request has
    // used, so an uncertain handoff can be retried without a second email.
    return this.sender.send(message, { idempotencyKey: request.id });
  }

  private reportProviderConfigurationFailure(status: 401 | 403): void {
    if (this.providerConfigurationAlerted) return;
    try {
      this.options.onProviderConfigurationFailure?.({ status });
      if (this.options.onProviderConfigurationFailure !== undefined) {
        this.providerConfigurationAlerted = true;
      }
    } catch {
      // A failed alert callback does not turn a held request into a delivery attempt.
    }
  }
}
