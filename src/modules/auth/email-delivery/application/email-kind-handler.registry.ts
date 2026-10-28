import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { isRecord } from '@/common/is-record';
import { OPAQUE_TOKEN_BINDINGS } from '@/common/security/opaque-token-issuer';
import {
  API_KEY_NEAR_EXPIRY_WINDOW_MS,
  type ApiKeyNearExpiryNotificationPayload,
  ApiKeyNearExpiryNotificationPayloadSchema,
  type AuthEmailDeliveryPayload,
  AuthEmailDeliveryPayloadSchema,
  type EmailNoticeResolvers,
  INVITE_EMAIL_ROLES,
  MfaSecurityNotificationPayloadSchema,
  OrganizationInviteEmailDeliveryPayloadSchema,
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

/**
 * A stored payload that passed its kind's schema. The typed payload is held
 * inside, so reading the credential or rendering never validates it again.
 * `render` may answer `undefined` when a notice is no longer actionable.
 */
export interface ValidatedEmailDelivery {
  credential(): Credential | undefined;
  render(
    context: EmailRenderContext,
  ): EmailMessage | undefined | Promise<EmailMessage | undefined>;
}

export interface EmailKindHandler<T> {
  isPayload(value: unknown): value is T;
  /** True for a payload that is valid except for a value this release lacks. */
  hasUnrecognisedValue(value: unknown): boolean;
  /** The typed delivery for a stored payload, or `undefined` when it is not one. */
  validate(value: unknown): ValidatedEmailDelivery | undefined;
}

function isInvitationRole(value: unknown): boolean {
  return INVITE_EMAIL_ROLES.some((role) => role === value);
}

/**
 * An invitation whose only fault is a role this release has not been taught:
 * written by a newer release, so it waits for one that knows the role instead
 * of failing as a corrupt payload (#484).
 */
function hasUnrecognisedInvitationRole(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.role === 'string' &&
    value.role.length > 0 &&
    !isInvitationRole(value.role) &&
    Value.Check(OrganizationInviteEmailDeliveryPayloadSchema, {
      ...value,
      role: INVITE_EMAIL_ROLES[0],
    })
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

function createEmailKindHandler<S extends TSchema>(
  schema: S,
  credential: (payload: Static<S>) => Credential | undefined,
  render: (
    payload: Static<S>,
    context: EmailRenderContext,
  ) => EmailMessage | undefined | Promise<EmailMessage | undefined>,
  hasUnrecognisedValue: (value: unknown) => boolean = () => false,
): EmailKindHandler<Static<S>> {
  const isPayload = (value: unknown): value is Static<S> =>
    Value.Check(schema, value);

  return {
    isPayload,
    hasUnrecognisedValue,
    validate: (value) =>
      isPayload(value)
        ? {
            credential: () => credential(value),
            render: (context) => render(value, context),
          }
        : undefined,
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
      AuthEmailDeliveryPayloadSchema,
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
      AuthEmailDeliveryPayloadSchema,
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
      OrganizationInviteEmailDeliveryPayloadSchema,
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
      hasUnrecognisedInvitationRole,
    ),
  },
  mfa_enabled_notification: {
    priorityTier: 2,
    dailyBudgetBucket: 'priority',
    staleCutoffMs: MAX_CREDENTIAL_LIFETIME_MS,
    staleCancellationReason: 'not_actionable',
    backpressureLifetimeMs: null,
    handler: createEmailKindHandler(
      MfaSecurityNotificationPayloadSchema,
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
      MfaSecurityNotificationPayloadSchema,
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
      ApiKeyNearExpiryNotificationPayloadSchema,
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
