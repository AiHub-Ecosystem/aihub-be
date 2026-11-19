import type { EmailDeliveryKind } from './email-kind-handler.registry';

export type { EmailDeliveryKind };

export const EMAIL_DELIVERY_REQUEST_STATUSES = [
  'queued',
  'provider_accepted',
  'failed',
  'cancelled',
] as const;

export type EmailDeliveryRequestStatus =
  (typeof EMAIL_DELIVERY_REQUEST_STATUSES)[number];

/** The bounded codes the table's own checks admit; nothing else is stored. */
export const EMAIL_DELIVERY_ERROR_CODES = [
  'timeout',
  'provider_rejected',
  'provider_permanent_rejection',
  'outcome_unknown',
  'payload_unreadable',
  // Deploy readers before the poller starts writing this value (#266).
  'key_unavailable',
] as const;

export type EmailDeliveryErrorCode =
  (typeof EMAIL_DELIVERY_ERROR_CODES)[number];

export const EMAIL_DELIVERY_CANCEL_REASONS = [
  'credential_expired',
  'credential_superseded',
  'credential_revoked',
  'not_actionable',
] as const;

export type EmailDeliveryCancelReason =
  (typeof EMAIL_DELIVERY_CANCEL_REASONS)[number];

export interface EmailDeliveryRequestRecord {
  readonly id: string;
  readonly kind: EmailDeliveryKind;
  readonly status: EmailDeliveryRequestStatus;
  readonly payloadCiphertext: string | null;
  readonly attempts: number;
  readonly lastAttemptAt: Date | null;
  readonly lastErrorCode: EmailDeliveryErrorCode | null;
  readonly cancelReason: EmailDeliveryCancelReason | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

/**
 * A terminal request claimed for its failure report. `claim` is the lease
 * expiry the claim wrote. A later claim is only possible once that instant has
 * passed, and writes a strictly later one, so it identifies this claim and no
 * other: acknowledging and releasing require it (#989).
 */
export interface ClaimedFailureReport extends EmailDeliveryRequestRecord {
  readonly claim: Date;
}

/** Queued rows of `kinds` created at or before `createdAtOrBefore`. */
export interface CancelStaleEmailDeliveryRequestsInput {
  readonly at: Date;
  readonly createdAtOrBefore: Date;
  readonly kinds: readonly EmailDeliveryKind[];
}

/**
 * One poller's share of the queue. `owner` names this instance and appears on
 * every row it holds, so a lease can be released or recognised after a restart;
 * `now` is the caller's clock, which keeps retry scheduling testable.
 */
export interface ClaimEmailDeliveryRequestsInput {
  readonly owner: string;
  readonly limit: number;
  readonly leaseMs: number;
  readonly now: Date;
  readonly ids?: readonly string[];
}

export interface EmailDeliveryDispatchState {
  readonly status: EmailDeliveryRequestStatus;
  readonly attempts: number;
  readonly lastAttemptAt: Date | null;
  readonly leaseExpiresAt: Date | null;
}

export interface EmailOutboxWalSlotHealth {
  readonly active: boolean;
  readonly retainedBytes: number;
  readonly safeBytes: number | null;
  readonly status: 'reserved' | 'extended' | 'unreserved' | 'lost';
}

export interface ReleaseUnspentEmailAttemptInput {
  readonly id: string;
  readonly owner: string;
  readonly previousAttempts: number;
  readonly previousAttemptAt: Date | null;
  readonly retryAt: Date;
}

interface InsertEmailDeliveryRequestBase {
  readonly id: string;
  readonly payloadCiphertext: string;
  readonly createdAt: Date;
}

export type InsertEmailDeliveryRequestInput =
  | (InsertEmailDeliveryRequestBase & {
      readonly kind: 'organization_invite_email';
      readonly organizationId: string;
      readonly inviterId: string;
    })
  | (InsertEmailDeliveryRequestBase & {
      readonly kind: Exclude<EmailDeliveryKind, 'organization_invite_email'>;
    });
