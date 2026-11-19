import type {
  CancelStaleEmailDeliveryRequestsInput,
  ClaimEmailDeliveryRequestsInput,
  ClaimedFailureReport,
  EmailDeliveryCancelReason,
  EmailDeliveryDispatchState,
  EmailDeliveryErrorCode,
  EmailDeliveryRequestRecord,
  ReleaseUnspentEmailAttemptInput,
} from './email-delivery-request.types';

export interface EmailDispatchClaimPort {
  claim(
    input: ClaimEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]>;
}

export interface EmailDispatchAttemptOutcomePort {
  /**
   * Counts the attempt before the provider is called, durably, and refuses a row
   * that has used its three. Counting it here rather than in the transition that
   * follows the call is what makes the cap a cap: a transition that fails leaves
   * the attempt spent, so no pass can reach the provider a fourth time.
   */
  reserveAttempt(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly owner: string;
  }): Promise<void>;
  /**
   * Every transition below carries the claimer's identity. A batch can outlive its
   * lease under a database stall or a paused process, and a claim that lapsed and
   * was taken by another instance must not be writable by the first one: it would
   * spend an attempt the new owner is spending, or clear the new owner's lease.
   * Requiring `owner` to still hold the row is what makes the lease a fence and
   * not a hint, so an update that matched nothing is a lost race rather than a
   * second writer.
   */
  /** Reverts a known non-consuming provider response and defers the row atomically. */
  releaseUnspentAttempt(input: ReleaseUnspentEmailAttemptInput): Promise<void>;
  markProviderAccepted(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly owner: string;
  }): Promise<void>;
  markFailed(input: {
    readonly id: string;
    readonly failedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
    readonly owner: string;
  }): Promise<void>;
  markCancelled(input: {
    readonly id: string;
    readonly cancelledAt: Date;
    readonly reason: EmailDeliveryCancelReason;
    readonly owner: string;
  }): Promise<void>;
  recordFailedAttempt(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
    readonly owner: string;
  }): Promise<void>;
  /**
   * Hands a claimed request back without recording an outcome, for one this
   * instance cannot finish yet. No attempt is spent and the payload stays, so the
   * next instance to claim it starts where this one stopped rather than
   * inheriting a terminal state. It is not claimable again before `retryAt`: a
   * row released for immediate reclaim would come back every pass and, once a
   * batch's worth of them existed, keep every other request from being claimed.
   */
  releaseDeferred(input: {
    readonly id: string;
    readonly owner: string;
    readonly retryAt: Date;
  }): Promise<void>;
}

export interface EmailDispatchSweepPort {
  /**
   * Cancels queued requests created at or before `createdAtOrBefore` whose lease
   * has lapsed, and erases their payload, without opening it. Every credential an
   * Email Delivery Request carries has expired by then, so the request can never
   * be sent; this is what erases a payload no instance can decrypt (ADR-0074).
   */
  cancelStale(
    input: CancelStaleEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]>;
  /**
   * Requests that spent their last attempt without a recorded outcome, whose
   * lease has lapsed. They are given up as `failed` rather than dispatched
   * again: the attempt cap is the cap, and a row nothing else will move must not
   * keep its payload or stay silent.
   */
  failExhausted(input: {
    readonly at: Date;
  }): Promise<readonly EmailDeliveryRequestRecord[]>;
}

export interface EmailDispatchFailureReportPort {
  /**
   * Terminal requests whose notification was never recorded, oldest first, so a
   * pass that starts after the one that failed them still emits their alert. The
   * row is no longer claimable by then, which is exactly why the durable record
   * has to be readable on its own.
   *
   * Claiming them is part of the call, and it takes a lease rather than marking
   * them reported: two instances reconciling at once produce one event between
   * them, while an instance that dies before emitting leaves the row claimable
   * again when the lease lapses. `markFailureReported` is what ends the sequence.
   *
   * Reporting is at least once, not exactly once: the signal is emitted before
   * the report is recorded, and they are not one transaction. A report whose
   * record fails is claimed and emitted again (#989).
   */
  claimUnreportedFailures(input: {
    readonly limit: number;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<readonly ClaimedFailureReport[]>;
  /**
   * Records the report, only while `claim` is still the row's claim: a
   * reporter whose lease lapsed and was claimed again changes nothing.
   */
  markFailureReported(input: {
    readonly id: string;
    readonly claim: Date;
    readonly reportedAt: Date;
  }): Promise<void>;
  /**
   * Hands a claim back without emitting, for a callback that threw. Without it
   * the row would stay invisible until the lease lapsed. Only the current
   * claim can hand it back.
   */
  releaseFailureNotification(input: {
    readonly id: string;
    readonly claim: Date;
  }): Promise<void>;
}

export interface EmailDispatchStateReadPort {
  readDispatchState(id: string): Promise<EmailDeliveryDispatchState | null>;
}

export interface EmailDispatchWalReadPort extends EmailDispatchStateReadPort {
  queuedIds(input: {
    readonly afterId?: string;
    readonly limit: number;
  }): Promise<readonly string[]>;
}

export interface EmailDispatchPollerPort
  extends EmailDispatchClaimPort,
    EmailDispatchAttemptOutcomePort,
    EmailDispatchSweepPort,
    EmailDispatchFailureReportPort,
    EmailDispatchStateReadPort {}

export interface EmailDispatchMaintenancePort
  extends EmailDispatchAttemptOutcomePort,
    EmailDispatchSweepPort,
    EmailDispatchFailureReportPort,
    EmailDispatchStateReadPort {}
