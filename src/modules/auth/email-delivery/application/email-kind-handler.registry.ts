import { isRecord } from '@/common/is-record';
import { OPAQUE_TOKEN_BINDINGS } from '@/common/security/opaque-token-issuer';
import {
  API_KEY_NEAR_EXPIRY_WINDOW_MS,
  type ApiKeyNearExpiryNotificationPayload,
  type AuthEmailDeliveryPayload,
  type EmailNoticeResolvers,
  INVITE_EMAIL_ROLES,
  type InviteEmailRole,
  type MfaSecurityNotificationPayload,
  type OrganizationInviteEmailDeliveryPayload,
  isApiKeyNearExpiryNotificationPayload,
} from './email-delivery-payload';
import {
  composeApiKeyNearExpiryNotification,
  composeMfaSecurityNotification,
  composeOrganizationInviteEmail,
  composePasswordResetEmail,
  composeVerificationEmail,
} from './email-message.composer';
import type { EmailMessage } from './email-sender.port';

type Credential = Pick<AuthEmailDeliveryPayload, 'token' | 'expiresAt'>;

export interface EmailRenderContext {
  readonly customerWebBaseUrl?: string;
  readonly now: Date;
  readonly notices: EmailNoticeResolvers;
}

/** `render` may answer `undefined` when a notice is no longer actionable. */
export interface EmailKindHandler<T> {
  isPayload(value: unknown): value is T;
  credential(payload: unknown): Credential | undefined;
  render(
    payload: unknown,
    context: EmailRenderContext,
  ): EmailMessage | undefined | Promise<EmailMessage | undefined>;
}

export interface ValidatedEmailDelivery {
  readonly handler: Pick<EmailKindHandler<unknown>, 'credential' | 'render'>;
  readonly payload: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isAuthEmailPayload(value: unknown): value is AuthEmailDeliveryPayload {
  return (
    isRecord(value) &&
    isNonEmptyString(value.email) &&
    isNonEmptyString(value.token) &&
    isNonEmptyString(value.expiresAt)
  );
}

function isInvitationRole(value: unknown): value is InviteEmailRole {
  return INVITE_EMAIL_ROLES.some((role) => role === value);
}

function isOrganizationInvitePayload(
  value: unknown,
): value is OrganizationInviteEmailDeliveryPayload {
  return (
    isRecord(value) &&
    isNonEmptyString(value.email) &&
    isNonEmptyString(value.token) &&
    isNonEmptyString(value.expiresAt) &&
    isNonEmptyString(value.organizationName) &&
    isInvitationRole(value.role) &&
    (value.inviterUsername === undefined ||
      isNonEmptyString(value.inviterUsername))
  );
}

function isMfaSecurityPayload(
  value: unknown,
): value is MfaSecurityNotificationPayload {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    isNonEmptyString(value.email)
  );
}

export class EmailNoticeResolverMissingError extends Error {
  readonly code = 'EMAIL_NOTICE_RESOLVER_MISSING';

  constructor(kind: string) {
    super(`${kind} notices cannot be resolved in this process`);
    this.name = 'EmailNoticeResolverMissingError';
  }
}

async function renderApiKeyNearExpiry(
  payload: ApiKeyNearExpiryNotificationPayload,
  context: EmailRenderContext,
): Promise<EmailMessage | undefined> {
  const resolver = context.notices.apiKeyNearExpiry;
  if (resolver === undefined) {
    throw new EmailNoticeResolverMissingError(API_KEY_NEAR_EXPIRY_KIND);
  }
  const input = await resolver.resolve(payload, context.now);
  return input === undefined
    ? undefined
    : composeApiKeyNearExpiryNotification(input, context.customerWebBaseUrl);
}

function createEmailKindHandler<T>(
  isPayload: (value: unknown) => value is T,
  credential: (payload: T) => Credential | undefined,
  render: (
    payload: T,
    context: EmailRenderContext,
  ) => EmailMessage | undefined | Promise<EmailMessage | undefined>,
): EmailKindHandler<T> {
  const forKind = (payload: unknown): T => {
    if (!isPayload(payload))
      throw new Error('email delivery payload is invalid');
    return payload;
  };

  return {
    isPayload,
    credential: (payload) => credential(forKind(payload)),
    render: (payload, context) => render(forKind(payload), context),
  };
}

export const MAX_CREDENTIAL_LIFETIME_MS = Math.max(
  ...Object.values(OPAQUE_TOKEN_BINDINGS).map((binding) => binding.ttlMs),
);

const API_KEY_NEAR_EXPIRY_KIND = 'api_key_near_expiry_notification';

export const EMAIL_KIND_POLICIES = {
  verification_email: {
    priorityTier: 1,
    dailyBudgetBucket: 'priority',
    staleCutoffMs: MAX_CREDENTIAL_LIFETIME_MS,
    staleCancellationReason: 'credential_expired',
    backpressureLifetimeMs: OPAQUE_TOKEN_BINDINGS.verification.ttlMs,
    handler: createEmailKindHandler(
      isAuthEmailPayload,
      (payload) => payload,
      (payload, { customerWebBaseUrl }) =>
        composeVerificationEmail(
          {
            email: payload.email,
            token: payload.token,
            expiresAt: new Date(Date.parse(payload.expiresAt)),
          },
          customerWebBaseUrl,
        ),
    ),
  },
  password_reset_email: {
    priorityTier: 0,
    dailyBudgetBucket: 'priority',
    staleCutoffMs: MAX_CREDENTIAL_LIFETIME_MS,
    staleCancellationReason: 'credential_expired',
    backpressureLifetimeMs: OPAQUE_TOKEN_BINDINGS.passwordReset.ttlMs,
    handler: createEmailKindHandler(
      isAuthEmailPayload,
      (payload) => payload,
      (payload, { customerWebBaseUrl }) =>
        composePasswordResetEmail(
          {
            email: payload.email,
            token: payload.token,
            expiresAt: new Date(Date.parse(payload.expiresAt)),
          },
          customerWebBaseUrl,
        ),
    ),
  },
  organization_invite_email: {
    priorityTier: 3,
    dailyBudgetBucket: 'invitation',
    staleCutoffMs: MAX_CREDENTIAL_LIFETIME_MS,
    staleCancellationReason: 'credential_expired',
    backpressureLifetimeMs: OPAQUE_TOKEN_BINDINGS.organizationInvite.ttlMs,
    handler: createEmailKindHandler(
      isOrganizationInvitePayload,
      (payload) => payload,
      (payload, { customerWebBaseUrl }) =>
        composeOrganizationInviteEmail(
          {
            email: payload.email,
            organizationName: payload.organizationName,
            role: payload.role,
            token: payload.token,
            expiresAt: new Date(Date.parse(payload.expiresAt)),
            ...(payload.inviterUsername === undefined
              ? {}
              : { inviterUsername: payload.inviterUsername }),
          },
          customerWebBaseUrl,
        ),
    ),
  },
  mfa_enabled_notification: {
    priorityTier: 2,
    dailyBudgetBucket: 'priority',
    staleCutoffMs: MAX_CREDENTIAL_LIFETIME_MS,
    staleCancellationReason: 'not_actionable',
    backpressureLifetimeMs: null,
    handler: createEmailKindHandler(
      isMfaSecurityPayload,
      () => undefined,
      (payload) =>
        composeMfaSecurityNotification({
          email: payload.email,
          action: 'enabled',
        }),
    ),
  },
  mfa_removed_notification: {
    priorityTier: 2,
    dailyBudgetBucket: 'priority',
    staleCutoffMs: MAX_CREDENTIAL_LIFETIME_MS,
    staleCancellationReason: 'not_actionable',
    backpressureLifetimeMs: null,
    handler: createEmailKindHandler(
      isMfaSecurityPayload,
      () => undefined,
      (payload) =>
        composeMfaSecurityNotification({
          email: payload.email,
          action: 'removed',
        }),
    ),
  },
  [API_KEY_NEAR_EXPIRY_KIND]: {
    priorityTier: 4,
    dailyBudgetBucket: 'invitation',
    staleCutoffMs: API_KEY_NEAR_EXPIRY_WINDOW_MS,
    staleCancellationReason: 'not_actionable',
    backpressureLifetimeMs: null,
    handler: createEmailKindHandler(
      isApiKeyNearExpiryNotificationPayload,
      () => undefined,
      renderApiKeyNearExpiry,
    ),
  },
} as const;

export type EmailDeliveryKind = keyof typeof EMAIL_KIND_POLICIES;

export const EMAIL_DELIVERY_KINDS: readonly EmailDeliveryKind[] = Object.freeze(
  Object.keys(EMAIL_KIND_POLICIES) as EmailDeliveryKind[],
);

export type EmailDeliveryPayloadByKind = {
  [K in EmailDeliveryKind]: (typeof EMAIL_KIND_POLICIES)[K]['handler'] extends EmailKindHandler<
    infer P
  >
    ? P
    : never;
};

export type EmailDeliveryPayload =
  EmailDeliveryPayloadByKind[EmailDeliveryKind];

export type BackpressureEmailKind = {
  [K in EmailDeliveryKind]: (typeof EMAIL_KIND_POLICIES)[K]['backpressureLifetimeMs'] extends number
    ? K
    : never;
}[EmailDeliveryKind];

export const EMAIL_BACKPRESSURE_KINDS: readonly BackpressureEmailKind[] =
  Object.freeze(
    EMAIL_DELIVERY_KINDS.filter(
      (kind): kind is BackpressureEmailKind =>
        EMAIL_KIND_POLICIES[kind].backpressureLifetimeMs !== null,
    ),
  );
