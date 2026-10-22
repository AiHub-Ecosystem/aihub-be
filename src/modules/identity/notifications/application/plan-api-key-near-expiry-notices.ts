import type { ApiKeyNearExpiryNotificationPayload } from '@/modules/auth/email-delivery/application/email-delivery-request.port';

export interface RecordedApiKeyNearExpiryEvent {
  readonly organizationId: string;
  readonly apiKeyId: string;
}

export interface ApiKeyNearExpiryRecipient {
  readonly organizationId: string;
  readonly userAccountId: string;
}

/**
 * One notice per recipient and Organization, listing every key that Organization
 * newly recorded in this sweep: two keys expiring together are one email, not
 * two (ADR-0120). A recipient whose Organization recorded nothing gets nothing.
 */
export function planApiKeyNearExpiryNotices(
  recorded: readonly RecordedApiKeyNearExpiryEvent[],
  recipients: readonly ApiKeyNearExpiryRecipient[],
): ApiKeyNearExpiryNotificationPayload[] {
  const keysByOrganization = new Map<string, string[]>();
  for (const event of recorded) {
    const keys = keysByOrganization.get(event.organizationId) ?? [];
    keys.push(event.apiKeyId);
    keysByOrganization.set(event.organizationId, keys);
  }
  return recipients.flatMap((recipient) => {
    const apiKeyIds = keysByOrganization.get(recipient.organizationId);
    return apiKeyIds === undefined
      ? []
      : [{ ...recipient, apiKeyIds: [...apiKeyIds].sort() }];
  });
}
