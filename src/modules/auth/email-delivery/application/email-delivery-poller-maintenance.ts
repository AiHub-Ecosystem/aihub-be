import { OPAQUE_TOKEN_BINDINGS } from '@/common/security/opaque-token-issuer';

import type {
  ClaimedFailureReport,
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
  EmailDeliveryKind,
  EmailDeliveryRequestRecord,
  EmailDispatchStorePort,
  ReleaseUnspentEmailAttemptInput,
} from './email-delivery-request.port';
import {
  API_KEY_NEAR_EXPIRY_WINDOW_MS,
  EMAIL_DELIVERY_KINDS,
} from './email-delivery-request.port';

export const MAX_DELIVERY_ATTEMPTS = 3;

export const MAX_CREDENTIAL_LIFETIME_MS = Math.max(
  ...Object.values(OPAQUE_TOKEN_BINDINGS).map((binding) => binding.ttlMs),
);

export interface EmailDeliveryPollerMaintenanceOptions {
  readonly owner: string;
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

  get hasPendingAttemptReleases(): boolean {
    return this.pendingUnspentAttempts.size > 0;
  }

  async reconcile(): Promise<{ cancelled: number; failed: number }> {
    const stale = await this.cancelStaleRequests();
    for (const id of stale) this.pendingUnspentAttempts.delete(id);
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
