import type { IdMinter } from '@/common/ids/prefixed-id';

/**
 * The closed set of things AIHUB tells an Organization it noticed on its own
 * (ADR-0120). Every emitter and channel names a kind from this list only.
 */
export const NOTIFICATION_KINDS = ['api-key.near-expiry'] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface ApiKeyNearExpirySweepSummary {
  readonly eventsRecorded: number;
  readonly emailsQueued: number;
  /** Keys in the window that already had their Notification Event. */
  readonly keysSkipped: number;
}

/**
 * Records a Notification Event for every eligible key expiring by `windowEnd`
 * and, in the same transaction, queues one notice per owner or admin of each
 * Organization that gained one. An event that already exists queues nothing.
 */
export interface RecordDueApiKeyNearExpiryNoticesInput {
  readonly now: Date;
  readonly windowEnd: Date;
  readonly newEventId: IdMinter;
  readonly newEmailDeliveryId: IdMinter;
}

export interface ApiKeyNearExpiryNoticeRecordPort {
  recordDue(
    input: RecordDueApiKeyNearExpiryNoticesInput,
  ): Promise<ApiKeyNearExpirySweepSummary>;
}
