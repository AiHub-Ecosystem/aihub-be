import type {
  EmailDeliveryCancelReason,
  EmailDeliveryKind,
  EmailDeliveryTransaction,
} from './email-delivery-request.port';
import type { EmailDeliveryPayloadByKind } from './email-kind-handler.registry';
import type { BackpressureEmailKind } from './email-outbox-backpressure.port';

export type { EmailDeliveryPayloadByKind } from './email-kind-handler.registry';

/** The kinds that carry a single-use credential minted for this email. */
type CredentialEmailKind =
  | 'verification_email'
  | 'password_reset_email'
  | 'organization_invite_email';

export type QueueEmailDeliveryRequestInput = {
  [K in EmailDeliveryKind]: {
    readonly kind: K;
    readonly payload: EmailDeliveryPayloadByKind[K];
    readonly createdAt: Date;
  } & (K extends 'organization_invite_email'
    ? { readonly organizationId: string; readonly inviterId: string }
    : object) &
    // The id of the token row or invitation, never the token, so support can
    // trace a sent email to what caused it (#441).
    (K extends CredentialEmailKind
      ? { readonly credentialId: string }
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
  /** Returns the Email Delivery Request id, for the caller's own audit trail. */
  queue(
    transaction: EmailDeliveryTransaction,
    input: QueueEmailDeliveryRequestInput,
  ): Promise<string>;
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
