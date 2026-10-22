import type { IdMinter } from '@/common/ids/prefixed-id';
import { API_KEY_NEAR_EXPIRY_WINDOW_MS } from '@/modules/auth/email-delivery/application/email-delivery-request.port';

import type {
  ApiKeyNearExpiryNoticeRecordPort,
  ApiKeyNearExpirySweepSummary,
} from './api-key-near-expiry-notice.port';

/**
 * The daily near-expiry sweep (ADR-0120). The window ends 14 days ahead rather
 * than being a one-day band, so a missed run is caught up by the next one and
 * a key created with less than 14 days of life is still told about.
 */
export class SweepApiKeyNearExpiry {
  constructor(
    private readonly records: ApiKeyNearExpiryNoticeRecordPort,
    private readonly newEventId: IdMinter,
    private readonly newEmailDeliveryId: IdMinter,
  ) {}

  run(now: Date): Promise<ApiKeyNearExpirySweepSummary> {
    return this.records.recordDue({
      now,
      windowEnd: new Date(now.getTime() + API_KEY_NEAR_EXPIRY_WINDOW_MS),
      newEventId: this.newEventId,
      newEmailDeliveryId: this.newEmailDeliveryId,
    });
  }
}
