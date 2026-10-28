/**
 * How far ahead the near-expiry sweep looks, and how long its notice stays
 * worth sending: by the end of the window every key it lists has expired
 * (ADR-0120).
 */
export const API_KEY_NEAR_EXPIRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Only references are sealed; recipient and key facts are read at dispatch. */
export interface ApiKeyNearExpiryNotificationPayload {
  readonly organizationId: string;
  readonly userAccountId: string;
  readonly apiKeyIds: readonly string[];
}

export function isApiKeyNearExpiryNotificationPayload(
  value: unknown,
): value is ApiKeyNearExpiryNotificationPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  // A member this release does not know is ignored: the previous release must
  // still read what the next one writes (#484).
  return (
    typeof candidate.organizationId === 'string' &&
    candidate.organizationId.length > 0 &&
    typeof candidate.userAccountId === 'string' &&
    candidate.userAccountId.length > 0 &&
    Array.isArray(candidate.apiKeyIds) &&
    candidate.apiKeyIds.length > 0 &&
    candidate.apiKeyIds.every((id) => typeof id === 'string' && id.length > 0)
  );
}

/** What a notice is composed from once its facts are read at dispatch. */
export interface ApiKeyNearExpiryNotificationInput {
  readonly email: string;
  readonly organizationId: string;
  readonly organizationName: string;
  /** Never empty: a notice with no active key left is not sent. */
  readonly apiKeys: readonly {
    readonly id: string;
    readonly name: string;
    readonly expiresAt: Date;
  }[];
}

/** Answers for a notice whose facts live in another module. */
export interface ApiKeyNearExpiryNoticeResolverPort {
  resolve(
    payload: ApiKeyNearExpiryNotificationPayload,
    now: Date,
  ): Promise<ApiKeyNearExpiryNotificationInput | undefined>;
}

/** Filled by the module that owns each notice's facts when it is constructed. */
export interface EmailNoticeResolvers {
  apiKeyNearExpiry?: ApiKeyNearExpiryNoticeResolverPort;
}

/** Worker input for authentication messages; it exists only inside ciphertext. */
export interface AuthEmailDeliveryPayload {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: string;
}

/** The roles an invitation email can name. */
export const INVITE_EMAIL_ROLES = ['owner', 'admin', 'member'] as const;

export type InviteEmailRole = (typeof INVITE_EMAIL_ROLES)[number];

export interface OrganizationInviteEmailDeliveryPayload
  extends AuthEmailDeliveryPayload {
  readonly organizationName: string;
  readonly role: InviteEmailRole;
  readonly inviterUsername?: string;
}

export interface MfaSecurityNotificationPayload {
  readonly email: string;
}
