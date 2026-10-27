import type {
  ApiKeyNearExpiryNotificationPayload,
  AuthEmailDeliveryPayload,
  EmailDeliveryCancelReason,
  EmailDeliveryKind,
  EmailDeliveryTransaction,
  MfaSecurityNotificationPayload,
  OrganizationInviteEmailDeliveryPayload,
} from './email-delivery-request.port';
import type { BackpressureEmailKind } from './email-outbox-backpressure.port';

export interface EmailDeliveryPayloadByKind {
  verification_email: AuthEmailDeliveryPayload;
  password_reset_email: AuthEmailDeliveryPayload;
  organization_invite_email: OrganizationInviteEmailDeliveryPayload;
  mfa_enabled_notification: MfaSecurityNotificationPayload;
  mfa_removed_notification: MfaSecurityNotificationPayload;
  api_key_near_expiry_notification: ApiKeyNearExpiryNotificationPayload;
}

export type QueueEmailDeliveryRequestInput = {
  [K in EmailDeliveryKind]: {
    readonly kind: K;
    readonly payload: EmailDeliveryPayloadByKind[K];
    readonly createdAt: Date;
  } & (K extends 'organization_invite_email'
    ? { readonly organizationId: string; readonly inviterId: string }
    : object);
}[EmailDeliveryKind];

export interface EmailOutboxPort {
  withAdmission<T>(
    kind: BackpressureEmailKind,
    operation: () => Promise<T>,
  ): Promise<T>;
  reserveAuthenticationEmailRecipient(
    transaction: EmailDeliveryTransaction,
    input: { readonly email: string; readonly now: Date },
  ): Promise<boolean>;
  queue(
    transaction: EmailDeliveryTransaction,
    input: QueueEmailDeliveryRequestInput,
  ): Promise<void>;
  withdraw<K extends EmailDeliveryKind>(
    transaction: EmailDeliveryTransaction,
    input: {
      readonly kind: K;
      readonly matches: (payload: EmailDeliveryPayloadByKind[K]) => boolean;
      readonly reason: EmailDeliveryCancelReason;
      readonly cancelledAt: Date;
    },
  ): Promise<void>;
}

export const EMAIL_OUTBOX = Symbol('EMAIL_OUTBOX');
