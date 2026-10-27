import type {
  EmailDeliveryCancelReason,
  EmailDeliveryKind,
  EmailDeliveryTransaction,
} from './email-delivery-request.port';
import type { EmailDeliveryPayloadByKind } from './email-kind-handler.registry';
import type { BackpressureEmailKind } from './email-outbox-backpressure.port';

export type { EmailDeliveryPayloadByKind } from './email-kind-handler.registry';

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
