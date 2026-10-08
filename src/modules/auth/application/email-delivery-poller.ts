import { OPAQUE_TOKEN_BINDINGS } from '@/common/security/opaque-token-issuer';

import type {
  AuthEmailDeliveryPayload,
  EmailCredentialActionabilityPort,
  EmailCredentialState,
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
  EmailDeliveryKind,
  EmailDeliveryRequestRecord,
  EmailDispatchStorePort,
  OrganizationInviteEmailDeliveryPayload,
} from './email-delivery-request.port';
import { EmailPayloadUnknownKeyVersionError } from './email-delivery-request.port';
import type { EmailPayloadCipherPort } from './email-delivery-request.port';
import { EMAIL_ATTEMPT_TIMEOUT_MS } from './email-sender.port';
import type { EmailSenderPort } from './email-sender.port';

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

/**
 * The longest any credential an Email Delivery Request carries stays valid. A
 * queued request older than this can never be sent, whatever its payload says.
 */
export const MAX_CREDENTIAL_LIFETIME_MS = Math.max(
  ...Object.values(OPAQUE_TOKEN_BINDINGS).map((binding) => binding.ttlMs),
);

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const INVITE_ROLES: readonly string[] = ['owner', 'admin', 'member'];

/**
 * The decrypted payload is data this process wrote, but it crosses a storage
 * boundary and a deploy can change its shape, so it is checked rather than
 * cast. A payload that does not match its kind is one no instance will ever be
 * able to send.
 */
function isPayloadFor(
  kind: EmailDeliveryKind,
  value: unknown,
): value is AuthEmailDeliveryPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (
    !isNonEmptyString(payload.email) ||
    !isNonEmptyString(payload.token) ||
    !isNonEmptyString(payload.expiresAt)
  ) {
    return false;
  }
  if (kind !== 'organization_invite_email') return true;
  return (
    isNonEmptyString(payload.organizationName) &&
    isNonEmptyString(payload.role) &&
    INVITE_ROLES.includes(payload.role)
  );
}

export interface EmailDeliveryPollerOptions {
  /** Identifies this instance on the rows it leases. */
  readonly owner: string;
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
 * Only two outcomes are worth keeping: the attempt ran out of time, or the
 * provider declined it. Anything the provider said about itself stays in the
 * provider, and the table admits no third code.
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

  constructor(
    private readonly store: EmailDispatchStorePort,
    private readonly credentials: EmailCredentialActionabilityPort,
    private readonly cipher: EmailPayloadCipherPort,
    private readonly sender: EmailSenderPort,
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
    const exhausted = await this.failExhaustedRequests();
    const claimed = await this.store.claim({
      owner: this.options.owner,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
      now: this.now(),
    });

    const summary = {
      claimed: claimed.length,
      providerAccepted: 0,
      cancelled: stale,
      failed: exhausted,
      deferred: 0,
    };
    for (const request of claimed) {
      try {
        const outcome = await this.dispatch(request);
        if (outcome === 'provider_accepted') summary.providerAccepted += 1;
        if (outcome === 'cancelled') summary.cancelled += 1;
        if (outcome === 'failed') summary.failed += 1;
        if (outcome === 'deferred') summary.deferred += 1;
      } catch {
        // The store is unreachable, or a transition lost a race with another
        // instance. The row keeps its lease and its payload, so the next pass
        // picks it up again; swallowing here is what keeps one bad row from
        // stranding the rest of the batch.
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
  private async cancelStaleRequests(): Promise<number> {
    const now = this.now();
    try {
      const cancelled = await this.store.cancelStale({
        at: now,
        createdAtOrBefore: new Date(now.getTime() - MAX_CREDENTIAL_LIFETIME_MS),
      });
      return cancelled.length;
    } catch {
      // The next pass retries; a stale row stays unsendable either way.
      return 0;
    }
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
    'provider_accepted' | 'cancelled' | 'failed' | 'retried' | 'deferred'
  > {
    const now = this.now();
    let payload: AuthEmailDeliveryPayload | undefined;
    try {
      payload = this.readPayload(request);
    } catch {
      return this.defer(request, now);
    }
    if (payload === undefined) {
      // A payload this instance cannot open will never open, so waiting would
      // claim the row forever without ever making it deliverable.
      return this.cancel(request, 'not_actionable', now);
    }

    const expiry = Date.parse(payload.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
      return this.cancel(request, 'credential_expired', now);
    }

    const state = await this.credentials.check({
      kind: request.kind,
      tokenHash: this.tokens.hash(payload.token),
      now,
    });
    if (state !== 'actionable') {
      return this.cancel(request, cancelReasonOf(state), now);
    }

    // The attempt is spent before the provider is called, not recorded after it
    // answers: a transition that fails must not hand the same request another
    // pass at the provider.
    await this.store.reserveAttempt({
      id: request.id,
      attemptedAt: now,
      owner: this.options.owner,
    });

    try {
      await this.deliver(request, payload);
    } catch (error) {
      return this.recordFailure(request, errorCodeOf(error), now);
    }

    await this.store.markProviderAccepted({
      id: request.id,
      attemptedAt: now,
      owner: this.options.owner,
    });
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
  ): AuthEmailDeliveryPayload | undefined {
    const ciphertext = request.payloadCiphertext;
    if (ciphertext === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.cipher.decrypt(ciphertext));
    } catch (error) {
      if (error instanceof EmailPayloadUnknownKeyVersionError) throw error;
      return undefined;
    }
    return isPayloadFor(request.kind, parsed) ? parsed : undefined;
  }

  private async defer(
    request: EmailDeliveryRequestRecord,
    now: Date,
  ): Promise<'deferred'> {
    await this.store.releaseDeferred({
      id: request.id,
      owner: this.options.owner,
      retryAt: new Date(now.getTime() + DEFER_RETRY_MS),
    });
    return 'deferred';
  }

  private async deliver(
    request: EmailDeliveryRequestRecord,
    payload: AuthEmailDeliveryPayload,
  ): Promise<void> {
    // The row's own id is the provider idempotency key: it is already unique,
    // already durable, and already what every attempt of this request has
    // used, so an uncertain handoff can be retried without a second email.
    const options = { idempotencyKey: request.id };
    const expiresAt = new Date(Date.parse(payload.expiresAt));

    if (request.kind === 'organization_invite_email') {
      const invitation = payload as OrganizationInviteEmailDeliveryPayload;
      await this.sender.sendOrganizationInviteEmail(
        {
          email: invitation.email,
          organizationName: invitation.organizationName,
          role: invitation.role,
          token: invitation.token,
          expiresAt,
        },
        options,
      );
      return;
    }

    const shared = { email: payload.email, token: payload.token, expiresAt };
    if (request.kind === 'verification_email') {
      await this.sender.sendVerificationEmail(shared, options);
      return;
    }
    await this.sender.sendPasswordResetEmail(shared, options);
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
