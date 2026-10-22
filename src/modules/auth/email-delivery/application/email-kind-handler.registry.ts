import type {
  ApiKeyNearExpiryNotificationPayload,
  AuthEmailDeliveryPayload,
  EmailDeliveryKind,
  EmailDeliveryPayload,
  EmailNoticeResolvers,
  MfaSecurityNotificationPayload,
  OrganizationInviteEmailDeliveryPayload,
} from './email-delivery-request.port';
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
 * `render` may answer `undefined`: a notice whose facts are read at dispatch
 * can find nothing left to tell, and is then not actionable.
 */
export interface EmailKindHandler {
  isPayload(value: unknown): value is EmailDeliveryPayload;
  credential(payload: EmailDeliveryPayload): Credential | undefined;
  render(
    payload: EmailDeliveryPayload,
    context: EmailRenderContext,
  ): EmailMessage | undefined | Promise<EmailMessage | undefined>;
}

export interface ValidatedEmailDelivery {
  readonly handler: EmailKindHandler;
  readonly payload: EmailDeliveryPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function isInvitationRole(
  value: unknown,
): value is OrganizationInviteEmailDeliveryPayload['role'] {
  return value === 'owner' || value === 'admin' || value === 'member';
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
    isInvitationRole(value.role)
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

function isApiKeyNearExpiryPayload(
  value: unknown,
): value is ApiKeyNearExpiryNotificationPayload {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isNonEmptyString(value.organizationId) &&
    isNonEmptyString(value.userAccountId) &&
    Array.isArray(value.apiKeyIds) &&
    value.apiKeyIds.length > 0 &&
    value.apiKeyIds.every(isNonEmptyString)
  );
}

/** This process was built without the module that owns a notice's facts. */
export class EmailNoticeResolverMissingError extends Error {
  readonly code = 'EMAIL_NOTICE_RESOLVER_MISSING';

  constructor(kind: EmailDeliveryKind) {
    super(`${kind} notices cannot be resolved in this process`);
    this.name = 'EmailNoticeResolverMissingError';
  }
}

/**
 * The facts live in Identity, so they are read when the notice is about to go
 * out. With no resolver in this process the render throws, which leaves the
 * row queued for an instance that has one instead of cancelling it.
 */
async function renderApiKeyNearExpiry(
  payload: ApiKeyNearExpiryNotificationPayload,
  context: EmailRenderContext,
): Promise<EmailMessage | undefined> {
  const resolver = context.notices.apiKeyNearExpiry;
  if (resolver === undefined) {
    throw new EmailNoticeResolverMissingError(
      'api_key_near_expiry_notification',
    );
  }
  const input = await resolver.resolve(payload, context.now);
  return input === undefined
    ? undefined
    : composeApiKeyNearExpiryNotification(input, context.customerWebBaseUrl);
}

function createEmailKindHandler<T extends EmailDeliveryPayload>(
  isPayload: (value: unknown) => value is T,
  credential: (payload: T) => Credential | undefined,
  render: (
    payload: T,
    context: EmailRenderContext,
  ) => EmailMessage | undefined | Promise<EmailMessage | undefined>,
): EmailKindHandler {
  const forKind = (payload: EmailDeliveryPayload): T => {
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

export const EMAIL_KIND_HANDLERS: Readonly<
  Record<EmailDeliveryKind, EmailKindHandler>
> = {
  verification_email: createEmailKindHandler(
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
  password_reset_email: createEmailKindHandler(
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
  organization_invite_email: createEmailKindHandler(
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
        },
        customerWebBaseUrl,
      ),
  ),
  mfa_enabled_notification: createEmailKindHandler(
    isMfaSecurityPayload,
    () => undefined,
    (payload) =>
      composeMfaSecurityNotification({
        email: payload.email,
        action: 'enabled',
      }),
  ),
  mfa_removed_notification: createEmailKindHandler(
    isMfaSecurityPayload,
    () => undefined,
    (payload) =>
      composeMfaSecurityNotification({
        email: payload.email,
        action: 'removed',
      }),
  ),
  api_key_near_expiry_notification: createEmailKindHandler(
    isApiKeyNearExpiryPayload,
    () => undefined,
    renderApiKeyNearExpiry,
  ),
};
