import { OPAQUE_TOKEN_BINDINGS } from '@/common/security/opaque-token-issuer';

import type {
  EmailCredentialActionabilityPort,
  EmailCredentialState,
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
  EmailDeliveryKind,
  EmailDeliveryRequestRecord,
  EmailDispatchStorePort,
  EmailNoticeResolvers,
  ReleaseUnspentEmailAttemptInput,
} from './email-delivery-request.port';
import {
  API_KEY_NEAR_EXPIRY_WINDOW_MS,
  EMAIL_DELIVERY_KINDS,
  EnvelopeCipherError,
} from './email-delivery-request.port';
import type { EmailPayloadCipherPort } from './email-delivery-request.port';
import { EMAIL_KIND_HANDLERS } from './email-kind-handler.registry';
import type { ValidatedEmailDelivery } from './email-kind-handler.registry';
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

/**
 * A request gets this many provider attempts before it is given up on
 * (ADR-0074). The delay before each retry is a property of the claim, which
 * reads `attempts` and `last_attempt_at` together, so there is one place that
 * decides when a request is due rather than two that can disagree.
 */
export const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * How long a request this instance could not open waits before any instance
 * claims it again. Long enough that a batch is never filled by the same
 * unopenable rows pass after pass, short enough that an instance holding the
 * key picks it up well inside the credential's lifetime.
 */
export const DEFER_RETRY_MS = 5 * 60_000;

/** Retry a reservation outage on the next poll pass without spending an attempt. */
export const EMAIL_SEND_RATE_LIMIT_RETRY_MS = 5_000;

/**
 * The longest any credential an Email Delivery Request carries stays valid. A
 * queued request older than this can never be sent, whatever its payload says.
 */
export const MAX_CREDENTIAL_LIFETIME_MS = Math.max(
  ...Object.values(OPAQUE_TOKEN_BINDINGS).map((binding) => binding.ttlMs),
);

/**
 * Each stale cutoff and the kinds it bounds. A near-expiry notice outlives the
 * credential cutoff on purpose: its event is already recorded, so cancelling it
 * after a day-long outage would drop the only warning its keys get (ADR-0120).
 */
const STALE_CUTOFFS: readonly {
  readonly ageMs: number;
  readonly kinds: readonly EmailDeliveryKind[];
}[] = [
  {
    ageMs: MAX_CREDENTIAL_LIFETIME_MS,
    kinds: EMAIL_DELIVERY_KINDS.filter(
      (kind) => kind !== 'api_key_near_expiry_notification',
    ),
  },
  {
    ageMs: API_KEY_NEAR_EXPIRY_WINDOW_MS,
    kinds: ['api_key_near_expiry_notification'],
  },
];

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

export interface EmailDeliveryPollerOptions {
  /** Identifies this instance on the rows it leases. */
  readonly owner: string;
  /** Validated by the Auth composition root; unset deployments use token-only copy. */
  readonly customerWebBaseUrl?: string;
  /** Filled by the modules that own a notice's facts; see the port. */
  readonly notices?: EmailNoticeResolvers;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  /**
   * Called once per request that used its last attempt. The application layer
   * has no logger and no metrics registry, so the infrastructure that composes
   * the poller decides what a terminal failure emits. Cancellation never
   * arrives here: ADR-0074 calls it expected lifecycle handling.
   */
  readonly onTerminalFailure?: (failure: {
    readonly id: string;
    readonly kind: EmailDeliveryKind;
    readonly errorCode: EmailDeliveryErrorCode;
  }) => void;
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
  // shortcut: retries survive only this process, durable recovery needs an attempt-outcome journal.
  private readonly pendingUnspentAttempts = new Map<
    string,
    ReleaseUnspentEmailAttemptInput
  >();

  constructor(
    private readonly store: EmailDispatchStorePort,
    private readonly credentials: EmailCredentialActionabilityPort,
    private readonly cipher: EmailPayloadCipherPort,
    private readonly sender: EmailSenderPort,
    private readonly sendRateLimiter: EmailSendRateLimiterPort,
    private readonly now: () => Date,
    private readonly tokens: { hash(raw: string): string },
    private readonly options: EmailDeliveryPollerOptions,
  ) {
    this.batchSize = options.batchSize ?? EmailDeliveryPoller.BATCH_SIZE;
    this.leaseMs =
      options.leaseMs ?? EmailDeliveryPoller.leaseMsFor(this.batchSize);
  }

  async runOnce(): Promise<EmailDispatchSummary> {
    const stale = await this.cancelStaleRequests();
    for (const id of stale) this.pendingUnspentAttempts.delete(id);
    await this.retryPendingUnspentAttempts();
    const exhausted =
      this.pendingUnspentAttempts.size === 0
        ? await this.failExhaustedRequests()
        : 0;
    const claimAt = this.now();
    const claimed =
      this.pendingUnspentAttempts.size > 0 ||
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
      cancelled: stale.length,
      failed: exhausted,
      deferred: 0,
    };
    let pauseBatch = false;
    for (const request of claimed) {
      if (pauseBatch) {
        try {
          await this.defer(request, this.now(), DEFER_RETRY_MS);
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
    await this.reportUnreportedFailures();
    return summary;
  }

  /**
   * Cancels requests that outlived every credential an Email Delivery Request
   * can carry, without opening them. This is what bounds a request that is never
   * dispatched — one sealed under a key version no instance holds, or one whose
   * credential check keeps failing — so its payload is still erased.
   */
  private async cancelStaleRequests(): Promise<string[]> {
    const now = this.now();
    const cancelledIds: string[] = [];
    for (const cutoff of STALE_CUTOFFS) {
      try {
        const cancelled = await this.store.cancelStale({
          at: now,
          createdAtOrBefore: new Date(now.getTime() - cutoff.ageMs),
          kinds: cutoff.kinds,
        });
        cancelledIds.push(...cancelled.map(({ id }) => id));
      } catch {
        // The next pass retries; a stale row stays unsendable either way.
      }
    }
    return cancelledIds;
  }

  /**
   * Gives up requests that spent their last attempt without a recorded outcome.
   *
   * The attempt is reserved before the provider is called, so a process that
   * dies in between leaves a row that is `queued`, already at the cap, and
   * excluded from every further claim. It would keep its ciphertext and never
   * report anything. This gives it up before the claim rather than calling the
   * provider a fourth time.
   */
  private async failExhaustedRequests(): Promise<number> {
    try {
      const failed = await this.store.failExhausted({ at: this.now() });
      return failed.length;
    } catch {
      // The next pass retries. Nothing is lost either way: an unreported
      // terminal row stays claimable until its alert is emitted.
      return 0;
    }
  }

  /**
   * Emits the alert for every terminal request that has no record of one, which
   * after a restart includes the ones whose own pass died before its callback.
   * A terminal row is not claimable, so without this its alert would be lost for
   * good — and reporting from durable state is what keeps the event at one per
   * terminal failure rather than one per pass.
   *
   * The store claims the rows before returning them under a lease, so a failure
   * two instances reconcile at once is reported once between them, and one this
   * instance dies reporting stays claimable again when the lease lapses.
   */
  private async reportUnreportedFailures(): Promise<void> {
    let pending: readonly EmailDeliveryRequestRecord[];
    try {
      pending = await this.store.claimUnreportedFailures({
        limit: this.batchSize,
        now: this.now(),
        leaseMs: this.leaseMs,
      });
    } catch {
      return;
    }
    for (const failure of pending) {
      // A failed row carries a bounded cause; the claim only returns ones that
      // do, and a row that somehow did not is left alone rather than reported
      // under a code nobody recorded.
      if (failure.lastErrorCode === null) continue;
      try {
        this.report({
          id: failure.id,
          kind: failure.kind,
          errorCode: failure.lastErrorCode,
        });
        await this.store.markFailureReported({
          id: failure.id,
          reportedAt: this.now(),
        });
      } catch {
        // Emitting is what has to be retried, not recorded: hand the claim back so
        // this row is reportable now rather than after the lease lapses. A
        // callback that throws is an observability defect, not a delivery one, so
        // it must not stop the rest of the batch.
        await this.releaseNotification(failure.id);
      }
    }
  }

  private async releaseNotification(id: string): Promise<void> {
    try {
      await this.store.releaseFailureNotification({ id });
    } catch {
      // The lease still lapses on its own, so this is a delay, not a loss.
    }
  }

  private report(failure: {
    readonly id: string;
    readonly kind: EmailDeliveryKind;
    readonly errorCode: EmailDeliveryErrorCode;
  }): void {
    this.options.onTerminalFailure?.(failure);
  }

  private async dispatch(
    request: EmailDeliveryRequestRecord,
  ): Promise<
    | 'provider_accepted'
    | 'cancelled'
    | 'failed'
    | 'retried'
    | 'deferred'
    | 'configuration_failure'
  > {
    const now = this.now();
    let delivery: ValidatedEmailDelivery | undefined;
    try {
      delivery = this.readPayload(request);
    } catch {
      return this.defer(request, now);
    }
    if (delivery === undefined) {
      // A payload this instance cannot open will never open, so waiting would
      // claim the row forever without ever making it deliverable.
      return this.cancel(request, 'not_actionable', now);
    }

    const credential = delivery.handler.credential(delivery.payload);
    if (credential !== undefined) {
      const expiry = Date.parse(credential.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
        return this.cancel(request, 'credential_expired', now);
      }

      const state = await this.credentials.check({
        kind: request.kind,
        tokenHash: this.tokens.hash(credential.token),
        now,
      });
      if (state !== 'actionable') {
        return this.cancel(request, cancelReasonOf(state), now);
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
      return this.cancel(request, 'not_actionable', now);
    }

    // The attempt is spent before the provider is called, not recorded after it
    // answers: a transition that fails must not hand the same request another
    // pass at the provider.
    let reservation;
    try {
      reservation = await this.sendRateLimiter.reserve();
    } catch {
      return this.defer(request, now, EMAIL_SEND_RATE_LIMIT_RETRY_MS);
    }
    if (!reservation.reserved) {
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
        return this.defer(request, now, EMAIL_SEND_RATE_LIMIT_RETRY_MS);
      }
      if (!budgetReservation.reserved) {
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

    await this.store.reserveAttempt({
      id: request.id,
      attemptedAt: now,
      owner: this.options.owner,
    });

    let response: EmailProviderResponse;
    try {
      response = await this.deliver(request, message);
    } catch (error) {
      return this.recordFailure(request, errorCodeOf(error), now);
    }

    const responseReceivedAt = this.now();

    if (response.status === 401 || response.status === 403) {
      this.providerPausedUntil = responseReceivedAt.getTime() + DEFER_RETRY_MS;
      this.reportProviderConfigurationFailure(response.status);
      await this.releaseUnspentAttempt(
        request,
        new Date(this.providerPausedUntil),
      );
      return 'configuration_failure';
    }

    if (response.status === 429) {
      await this.releaseUnspentAttempt(
        request,
        new Date(
          responseReceivedAt.getTime() +
            emailProviderRetryAfterMs(response.retryAfter, responseReceivedAt),
        ),
      );
      return 'deferred';
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
      return this.recordFailure(request, 'provider_rejected', now);
    }

    await this.store.markProviderAccepted({
      id: request.id,
      attemptedAt: now,
      owner: this.options.owner,
    });
    this.providerConfigurationAlerted = false;
    return 'provider_accepted';
  }

  /**
   * `undefined` is a payload that will never open: absent, an envelope this
   * instance cannot make sense of, or plaintext that is not the shape its kind
   * needs. An unknown key version is not that, and is rethrown so the row can
   * go back with its ciphertext instead of being cancelled out from under an
   * instance that holds the key.
   */
  private readPayload(
    request: EmailDeliveryRequestRecord,
  ): ValidatedEmailDelivery | undefined {
    const ciphertext = request.payloadCiphertext;
    if (ciphertext === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.cipher.decrypt(ciphertext));
    } catch (error) {
      if (error instanceof EnvelopeCipherError && error.kind === 'unknown-key')
        throw error;
      return undefined;
    }
    const handler = EMAIL_KIND_HANDLERS[request.kind];
    return handler !== undefined && handler.isPayload(parsed)
      ? { handler, payload: parsed }
      : undefined;
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

  private async deliver(
    request: EmailDeliveryRequestRecord,
    message: EmailMessage,
  ): Promise<EmailProviderResponse> {
    // The row's own id is the provider idempotency key: it is already unique,
    // already durable, and already what every attempt of this request has
    // used, so an uncertain handoff can be retried without a second email.
    return this.sender.send(message, { idempotencyKey: request.id });
  }

  private async releaseUnspentAttempt(
    request: EmailDeliveryRequestRecord,
    retryAt: Date,
  ): Promise<void> {
    const input = {
      id: request.id,
      owner: this.options.owner,
      previousAttempts: request.attempts,
      previousAttemptAt: request.lastAttemptAt,
      retryAt,
    };
    this.pendingUnspentAttempts.set(request.id, input);
    await this.store.releaseUnspentAttempt(input);
    this.pendingUnspentAttempts.delete(request.id);
  }

  private async retryPendingUnspentAttempts(): Promise<void> {
    for (const [id, input] of this.pendingUnspentAttempts) {
      try {
        await this.store.releaseUnspentAttempt(input);
        this.pendingUnspentAttempts.delete(id);
      } catch {
        // Keep the known non-consuming outcome ahead of the exhausted sweep.
      }
    }
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

  /**
   * The last allowed attempt is terminal; anything earlier only moves the next
   * one forward. `attempts` is what the row already carries, so the request
   * that follows the final attempt is the one that stops.
   */
  private async recordFailure(
    request: EmailDeliveryRequestRecord,
    errorCode: EmailDeliveryErrorCode,
    now: Date,
  ): Promise<'retried' | 'failed'> {
    if (request.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) {
      await this.store.markFailed({
        id: request.id,
        failedAt: now,
        errorCode,
        owner: this.options.owner,
      });
      // The alert is not emitted here. The moment this commits, the row is
      // eligible for another instance's reconciliation, so emitting from this
      // path would let both instances report the same failure. Reconciliation at
      // the end of this pass claims the row under the notification lease and
      // emits it, so it is still this pass that reports it.
      return 'failed';
    }
    await this.store.recordFailedAttempt({
      id: request.id,
      attemptedAt: now,
      errorCode,
      owner: this.options.owner,
    });
    return 'retried';
  }

  private async cancel(
    request: EmailDeliveryRequestRecord,
    reason: EmailDeliveryCancelReason,
    now: Date,
  ): Promise<'cancelled'> {
    await this.store.markCancelled({
      id: request.id,
      cancelledAt: now,
      reason,
      owner: this.options.owner,
    });
    return 'cancelled';
  }
}
