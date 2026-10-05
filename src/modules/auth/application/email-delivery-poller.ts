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
import type { EmailPayloadCipher } from './email-delivery-request.port';
import { EMAIL_ATTEMPT_TIMEOUT_MS } from './email-sender.port';
import type { EmailSenderPort } from './email-sender.port';

/**
 * A request gets this many provider attempts before it is given up on
 * (ADR-0074). The delay before each retry is a property of the claim, which
 * reads `attempts` and `last_attempt_at` together, so there is one place that
 * decides when a request is due rather than two that can disagree.
 */
export const MAX_DELIVERY_ATTEMPTS = 3;

export interface EmailDispatchSummary {
  readonly claimed: number;
  readonly providerAccepted: number;
  readonly cancelled: number;
  /** Requests that exhausted their attempts; a retried one is not failed. */
  readonly failed: number;
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
   * A lease has to outlive the whole batch, not one request: a poller holds a
   * full batch of rows while it works through them, and a lease that expired
   * mid-batch would let a second instance re-claim a row this one is still
   * sending.
   */
  static readonly LEASE_MS = 60_000;

  private readonly batchSize: number;
  private readonly leaseMs: number;

  constructor(
    private readonly store: EmailDispatchStorePort,
    private readonly credentials: EmailCredentialActionabilityPort,
    private readonly cipher: EmailPayloadCipher,
    private readonly sender: EmailSenderPort,
    private readonly now: () => Date,
    private readonly tokens: { hash(raw: string): string },
    private readonly options: EmailDeliveryPollerOptions,
  ) {
    this.batchSize = options.batchSize ?? EmailDeliveryPoller.BATCH_SIZE;
    this.leaseMs = options.leaseMs ?? EmailDeliveryPoller.LEASE_MS;
  }

  async runOnce(): Promise<EmailDispatchSummary> {
    const claimed = await this.store.claim({
      owner: this.options.owner,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
      now: this.now(),
    });

    const summary = {
      claimed: claimed.length,
      providerAccepted: 0,
      cancelled: 0,
      failed: 0,
    };
    for (const request of claimed) {
      try {
        const outcome = await this.dispatch(request);
        if (outcome === 'provider_accepted') summary.providerAccepted += 1;
        if (outcome === 'cancelled') summary.cancelled += 1;
        if (outcome === 'failed') summary.failed += 1;
      } catch {
        // The store is unreachable, or a transition lost a race with another
        // instance. The row keeps its lease and its payload, so the next pass
        // picks it up again; swallowing here is what keeps one bad row from
        // stranding the rest of the batch.
      }
    }
    return summary;
  }

  private async dispatch(
    request: EmailDeliveryRequestRecord,
  ): Promise<'provider_accepted' | 'cancelled' | 'failed' | 'retried'> {
    const now = this.now();
    const payload = this.readPayload(request);
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

    try {
      await this.deliver(request, payload);
    } catch (error) {
      return this.recordFailure(request, errorCodeOf(error), now);
    }

    await this.store.markProviderAccepted({ id: request.id, attemptedAt: now });
    return 'provider_accepted';
  }

  private readPayload(
    request: EmailDeliveryRequestRecord,
  ): AuthEmailDeliveryPayload | undefined {
    const ciphertext = request.payloadCiphertext;
    if (ciphertext === null) return undefined;
    try {
      return JSON.parse(
        this.cipher.decrypt(ciphertext),
      ) as AuthEmailDeliveryPayload;
    } catch {
      return undefined;
    }
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
      });
      this.options.onTerminalFailure?.({
        id: request.id,
        kind: request.kind,
        errorCode,
      });
      return 'failed';
    }
    await this.store.recordFailedAttempt({
      id: request.id,
      attemptedAt: now,
      errorCode,
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
    });
    return 'cancelled';
  }
}
