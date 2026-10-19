import type {
  AuthEmailDeliveryPayload,
  EmailDeliveryKind,
  EmailDeliveryPayload,
  MfaSecurityNotificationPayload,
  OrganizationInviteEmailDeliveryPayload,
} from './email-delivery-request.port';
import {
  composeMfaSecurityNotification,
  composeOrganizationInviteEmail,
  composePasswordResetEmail,
  composeVerificationEmail,
} from './email-message.composer';
import type { EmailMessage } from './email-sender.port';

type Credential = Pick<AuthEmailDeliveryPayload, 'token' | 'expiresAt'>;

export interface EmailKindHandler {
  isPayload(value: unknown): value is EmailDeliveryPayload;
  credential(payload: EmailDeliveryPayload): Credential | undefined;
  render(
    payload: EmailDeliveryPayload,
    customerWebBaseUrl?: string,
  ): EmailMessage;
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

function createEmailKindHandler<T extends EmailDeliveryPayload>(
  isPayload: (value: unknown) => value is T,
  credential: (payload: T) => Credential | undefined,
  render: (payload: T, customerWebBaseUrl?: string) => EmailMessage,
): EmailKindHandler {
  const forKind = (payload: EmailDeliveryPayload): T => {
    if (!isPayload(payload))
      throw new Error('email delivery payload is invalid');
    return payload;
  };

  return {
    isPayload,
    credential: (payload) => credential(forKind(payload)),
    render: (payload, customerWebBaseUrl) =>
      render(forKind(payload), customerWebBaseUrl),
  };
}

export const EMAIL_KIND_HANDLERS: Readonly<
  Record<EmailDeliveryKind, EmailKindHandler>
> = {
  verification_email: createEmailKindHandler(
    isAuthEmailPayload,
    (payload) => payload,
    (payload, customerWebBaseUrl) =>
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
    (payload, customerWebBaseUrl) =>
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
    (payload, customerWebBaseUrl) =>
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
};
