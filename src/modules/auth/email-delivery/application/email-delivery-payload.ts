import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * How far ahead the near-expiry sweep looks, and how long its notice stays
 * worth sending: by the end of the window every key it lists has expired
 * (ADR-0120).
 */
export const API_KEY_NEAR_EXPIRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const NonEmptyString = Type.String({ minLength: 1 });

// Stored payloads are read by a release older or newer than the one that wrote
// them, so these object schemas stay open: a member this release does not know
// is ignored, while a known member of the wrong type fails validation (#484).

/** Only references are sealed; recipient and key facts are read at dispatch. */
export const ApiKeyNearExpiryNotificationPayloadSchema = Type.Object({
  organizationId: NonEmptyString,
  userAccountId: NonEmptyString,
  apiKeyIds: Type.Array(NonEmptyString, { minItems: 1 }),
});

export type ApiKeyNearExpiryNotificationPayload = Static<
  typeof ApiKeyNearExpiryNotificationPayloadSchema
>;

export function isApiKeyNearExpiryNotificationPayload(
  value: unknown,
): value is ApiKeyNearExpiryNotificationPayload {
  return Value.Check(ApiKeyNearExpiryNotificationPayloadSchema, value);
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
export const AuthEmailDeliveryPayloadSchema = Type.Object({
  email: NonEmptyString,
  token: NonEmptyString,
  expiresAt: NonEmptyString,
});

export type AuthEmailDeliveryPayload = Static<
  typeof AuthEmailDeliveryPayloadSchema
>;

/** The roles an invitation email can name. */
export const INVITE_EMAIL_ROLES = ['owner', 'admin', 'member'] as const;

export type InviteEmailRole = (typeof INVITE_EMAIL_ROLES)[number];

export const OrganizationInviteEmailDeliveryPayloadSchema = Type.Object({
  ...AuthEmailDeliveryPayloadSchema.properties,
  organizationName: NonEmptyString,
  role: Type.Union(INVITE_EMAIL_ROLES.map((role) => Type.Literal(role))),
  inviterUsername: Type.Optional(NonEmptyString),
});

export const MfaSecurityNotificationPayloadSchema = Type.Object({
  email: NonEmptyString,
});
