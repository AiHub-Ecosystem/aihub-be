import type {
  ClaimedFailureReport,
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
  EmailDeliveryKind,
  EmailDeliveryRequestRecord,
  EmailDispatchStorePort,
  ReleaseUnspentEmailAttemptInput,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import {
  EMAIL_DELIVERY_KINDS,
  EMAIL_KIND_POLICIES,
} from '@/modules/auth/email-delivery/application/email-kind-handler.registry';
import type { EmailIdempotencyConflict } from '@/modules/auth/email-delivery/application/email-sender.port';
import { invitationRecipientRetryAfterMs } from '@/modules/auth/email-delivery/application/send-policy/invitation-recipient-rate-limit';
import type { AuthRateLimiterPort } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';

export const MAX_DELIVERY_ATTEMPTS = 3;

export { MAX_CREDENTIAL_LIFETIME_MS } from '@/modules/auth/email-delivery/application/email-kind-handler.registry';

export interface EmailDeliveryPollerMaintenanceOptions {
  readonly owner: string;
  readonly invitationEmailRateLimiter?: AuthRateLimiterPort;
  readonly onTerminalFailure?: (failure: {
    readonly id: string;
    readonly kind: EmailDeliveryKind;
    readonly errorCode: EmailDeliveryErrorCode;
  }) => void;
}

/** Keeps queued-row cleanup and terminal reporting active during provider outages. */
export class EmailDeliveryPollerMaintenance {
  private readonly pendingUnspentAttempts = new Map<
    string,
    ReleaseUnspentEmailAttemptInput
  >();

  constructor(
    private readonly store: EmailDispatchStorePort,
    private readonly now: () => Date,
    private readonly options: EmailDeliveryPollerMaintenanceOptions,
    private readonly batchSize: number,
    private readonly leaseMs: number,
  ) {}

  /**
   * A conflict whose terminal write was rejected (#441): the provider may have
   * accepted the first handoff, so the request must be settled as failed before
   * it can be claimed and sent again.
   */
  private readonly pendingConflictFailures = new Map<
    string,
    Parameters<EmailDispatchStorePort['markFailed']>[0]
  >();

  /** Outcomes known to the provider but not yet durable: no claim until settled. */
  get hasPendingAttemptReleases(): boolean {
    return (
      this.pendingUnspentAttempts.size > 0 ||
      this.pendingConflictFailures.size > 0
    );
  }

  async deferInvitationAtRecipientLimit(
    request: EmailDeliveryRequestRecord,
    recipient: string,
    now: Date,
    fallbackMs: number,
  ): Promise<boolean> {
    if (request.kind !== 'organization_invite_email') return false;
    const retryAfterMs = await invitationRecipientRetryAfterMs(
      this.options.invitationEmailRateLimiter,
      recipient,
      fallbackMs,
    );
    if (retryAfterMs === undefined) return false;
    await this.store.releaseDeferred({
      id: request.id,
      owner: this.options.owner,
      retryAt: new Date(now.getTime() + retryAfterMs),
    });
    return true;
  }

  async defer(
    request: EmailDeliveryRequestRecord,
    now: Date,
    retryAfterMs: number,
  ): Promise<'deferred'> {
    await this.store.releaseDeferred({
      id: request.id,
      owner: this.options.owner,
      retryAt: new Date(now.getTime() + retryAfterMs),
    });
    return 'deferred';
  }

  async reconcile(): Promise<{ cancelled: number; failed: number }> {
    // Settled first: a row whose conflict outcome lands is no longer queued, so
    // the stale sweep cannot cancel it and lose the outcome (#441).
    await this.retryPendingConflictFailures();
    const stale = await this.cancelStaleRequests();
    for (const id of stale) {
      this.pendingUnspentAttempts.delete(id);
      this.pendingConflictFailures.delete(id);
    }
    await this.retryPendingUnspentAttempts();
    const failed = this.hasPendingAttemptReleases
      ? 0
      : await this.failExhaustedRequests();
    return { cancelled: stale.length, failed };
  }

  async reportUnreportedFailures(): Promise<void> {
    let pending: readonly ClaimedFailureReport[];
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
      if (failure.lastErrorCode === null) continue;
      try {
        this.options.onTerminalFailure?.({
          id: failure.id,
          kind: failure.kind,
          errorCode: failure.lastErrorCode,
        });
        await this.store.markFailureReported({
          id: failure.id,
          claim: failure.claim,
          reportedAt: this.now(),
        });
      } catch {
        // The signal may already be out: the next claim emits it again, which
        // is the at-least-once the runbook states (#989).
        await this.releaseNotification(failure);
      }
    }
  }

  async releaseUnspentAttempt(
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

  async recordFailure(
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

  /**
   * A reused provider key is never a definitive rejection (#441). `concurrent`
   * means the provider is still processing an earlier attempt under the key, so
   * it spends one of the bounded attempts and is retried. `payload_changed`
   * means an earlier attempt under the key reached the provider and may have
   * been delivered, so the request ends as `outcome_unknown`, which alerts,
   * rather than being sent again.
   */
  async recordIdempotencyConflict(
    request: EmailDeliveryRequestRecord,
    conflict: EmailIdempotencyConflict,
    at: Date,
  ): Promise<'retried' | 'failed'> {
    if (conflict === 'concurrent') {
      return this.recordFailure(request, 'outcome_unknown', at);
    }
    const input = {
      id: request.id,
      failedAt: at,
      errorCode: 'outcome_unknown',
      owner: this.options.owner,
    } as const;
    // Remembered until the write lands: a rejected write leaves the row queued,
    // and the next pass settles it before it can claim anything.
    this.pendingConflictFailures.set(request.id, input);
    await this.store.markFailed(input);
    this.pendingConflictFailures.delete(request.id);
    return 'failed';
  }

  async cancel(
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

  private async failExhaustedRequests(): Promise<number> {
    try {
      const failed = await this.store.failExhausted({ at: this.now() });
      return failed.length;
    } catch {
      return 0;
    }
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

  private async retryPendingConflictFailures(): Promise<void> {
    for (const [id, input] of this.pendingConflictFailures) {
      try {
        await this.store.markFailed(input);
        this.pendingConflictFailures.delete(id);
      } catch {
        // A write that committed but answered with an error leaves nothing to
        // settle, and retrying it would fail for good and block every claim.
        if (await this.isSettled(id)) this.pendingConflictFailures.delete(id);
        // Otherwise kept: no claim starts while an outcome waits to be recorded.
      }
    }
  }

  /** True once the row is no longer queued (or is gone): there is nothing to write. */
  private async isSettled(id: string): Promise<boolean> {
    try {
      const state = await this.store.readDispatchState(id);
      return state === null || state.status !== 'queued';
    } catch {
      return false;
    }
  }

  private async releaseNotification(
    failure: ClaimedFailureReport,
  ): Promise<void> {
    try {
      await this.store.releaseFailureNotification({
        id: failure.id,
        claim: failure.claim,
      });
    } catch {
      // The lease still lapses on its own, so this is a delay, not a loss.
    }
  }
}

const STALE_CUTOFFS: readonly {
  readonly ageMs: number;
  readonly kinds: readonly EmailDeliveryKind[];
}[] = [
  ...new Set(
    EMAIL_DELIVERY_KINDS.map((kind) => EMAIL_KIND_POLICIES[kind].staleCutoffMs),
  ),
].map((ageMs) => ({
  ageMs,
  kinds: EMAIL_DELIVERY_KINDS.filter(
    (kind) => EMAIL_KIND_POLICIES[kind].staleCutoffMs === ageMs,
  ),
}));
