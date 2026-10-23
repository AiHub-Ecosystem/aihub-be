import { AppError } from '@/common/errors/app-error';
import type {
  CancelStaleEmailDeliveryRequestsInput,
  ClaimEmailDeliveryRequestsInput,
  ClaimedFailureReport,
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
  EmailDeliveryRequestRecord,
  EmailDispatchStorePort,
  ReleaseUnspentEmailAttemptInput,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { claimEmailDeliveryRequests } from './email-delivery-claim';
import { PostgresEmailDeliveryRequestRepository } from './postgres-email-delivery-request.repository';
import type { EmailDeliveryBacklogRow } from './postgres-email-delivery-request.repository';
import { readEmailOutboxCancellationTimestamps } from './postgres-email-outbox-cancellation-metrics';

/**
 * Claims run in a short transaction; dispatch runs outside it, so no database
 * connection is held while a provider call is in flight.
 */
export class PostgresEmailDispatchStore implements EmailDispatchStorePort {
  constructor(
    private readonly client: Parameters<typeof claimEmailDeliveryRequests>[0],
    private readonly requests = new PostgresEmailDeliveryRequestRepository(),
  ) {}

  claim(
    input: ClaimEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    return this.requests.claim(this.client, input);
  }

  async markProviderAccepted(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly owner: string;
  }): Promise<void> {
    await this.requests.markProviderAccepted(this.client, input);
  }

  async markFailed(input: {
    readonly id: string;
    readonly failedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
    readonly owner: string;
  }): Promise<void> {
    await this.requests.markFailed(this.client, input);
  }

  async failExhausted(input: {
    readonly at: Date;
  }): Promise<readonly EmailDeliveryRequestRecord[]> {
    return this.requests.failExhausted(this.client, input);
  }

  async markCancelled(input: {
    readonly id: string;
    readonly cancelledAt: Date;
    readonly reason: EmailDeliveryCancelReason;
    readonly owner: string;
  }): Promise<void> {
    await this.requests.markCancelled(this.client, input);
  }

  async recordFailedAttempt(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
    readonly owner: string;
  }): Promise<void> {
    await this.requests.recordFailedAttempt(this.client, input);
  }

  async reserveAttempt(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly owner: string;
  }): Promise<void> {
    await this.requests.reserveAttempt(this.client, input);
  }

  async releaseUnspentAttempt(
    input: ReleaseUnspentEmailAttemptInput,
  ): Promise<void> {
    let updated: { readonly count: number };
    try {
      updated = await this.client.emailDeliveryRequest.updateMany({
        where: {
          id: input.id,
          status: 'queued',
          leaseOwner: input.owner,
          attempts: { gt: 0 },
        },
        data: {
          attempts: { decrement: 1 },
          lastAttemptAt: input.previousAttemptAt,
          leaseOwner: null,
          leaseExpiresAt: input.retryAt,
        },
      });
    } catch (error) {
      if ((await this.unspentAttemptState(input)) !== 'still_owed') return;
      throw error;
    }
    if (updated.count > 0) return;
    if ((await this.unspentAttemptState(input)) !== 'still_owed') return;
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Email delivery request is not in a queued state',
      retryable: false,
    });
  }

  /**
   * Whether a refund still has anything to do, read after the fenced update
   * could not show it. `released`: an earlier attempt of this refund committed.
   * `not_ours`: the row is gone, terminal, or held by another claimant, so there
   * is nothing this worker may refund; treating that as a failure would keep the
   * refund pending forever and stop this poller claiming any mail (#1033).
   * `still_owed`: the row is queued and still this worker's, so the refund is
   * genuinely outstanding. A failed read throws, which keeps it pending.
   */
  private async unspentAttemptState(
    input: ReleaseUnspentEmailAttemptInput,
  ): Promise<'released' | 'not_ours' | 'still_owed'> {
    const row = await this.client.emailDeliveryRequest.findUnique({
      where: { id: input.id },
      select: {
        status: true,
        attempts: true,
        lastAttemptAt: true,
        leaseExpiresAt: true,
        leaseOwner: true,
      },
    });
    if (
      row?.status === 'queued' &&
      row.attempts === input.previousAttempts &&
      row.lastAttemptAt?.getTime() === input.previousAttemptAt?.getTime() &&
      row.leaseExpiresAt?.getTime() === input.retryAt.getTime()
    ) {
      return 'released';
    }
    return row?.status === 'queued' && row.leaseOwner === input.owner
      ? 'still_owed'
      : 'not_ours';
  }

  async releaseDeferred(input: {
    readonly id: string;
    readonly owner: string;
    readonly retryAt: Date;
  }): Promise<void> {
    await this.requests.releaseDeferred(this.client, input);
  }

  cancelStale(
    input: CancelStaleEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    return this.requests.cancelStale(this.client, input);
  }

  /** Not part of the dispatch port: only the backlog metrics read it. */
  backlog(input: {
    readonly now: Date;
  }): Promise<readonly EmailDeliveryBacklogRow[]> {
    return this.requests.backlog(this.client, input);
  }

  /** Durable bounded cancellation samples for alerting. */
  cancellationTimestamps(): ReturnType<
    typeof readEmailOutboxCancellationTimestamps
  > {
    return readEmailOutboxCancellationTimestamps(this.client);
  }

  claimUnreportedFailures(input: {
    readonly limit: number;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<readonly ClaimedFailureReport[]> {
    return this.requests.claimUnreportedFailures(this.client, input);
  }

  async markFailureReported(input: {
    readonly id: string;
    readonly claim: Date;
    readonly reportedAt: Date;
  }): Promise<void> {
    await this.requests.markFailureReported(this.client, input);
  }

  async releaseFailureNotification(input: {
    readonly id: string;
    readonly claim: Date;
  }): Promise<void> {
    await this.requests.releaseFailureNotification(this.client, input);
  }
}
