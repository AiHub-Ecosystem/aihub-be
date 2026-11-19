import type {
  EmailDeliveryCancelReason,
  EmailDeliveryKind,
  InsertEmailDeliveryRequestInput,
} from './email-delivery-request.types';

export {
  EMAIL_DELIVERY_KINDS,
  type EmailDeliveryKind,
  type EmailDeliveryPayload,
} from './email-kind-handler.registry';
export {
  API_KEY_NEAR_EXPIRY_WINDOW_MS,
  type ApiKeyNearExpiryNotificationInput,
  type ApiKeyNearExpiryNotificationPayload,
  type ApiKeyNearExpiryNoticeResolverPort,
  type AuthEmailDeliveryPayload,
  type EmailNoticeResolvers,
  isApiKeyNearExpiryNotificationPayload,
} from './payload/email-delivery-payload';
export {
  EMAIL_DELIVERY_CANCEL_REASONS,
  EMAIL_DELIVERY_ERROR_CODES,
  EMAIL_DELIVERY_REQUEST_STATUSES,
  type CancelStaleEmailDeliveryRequestsInput,
  type ClaimEmailDeliveryRequestsInput,
  type ClaimedFailureReport,
  type EmailDeliveryCancelReason,
  type EmailDeliveryErrorCode,
  type EmailDeliveryRequestRecord,
  type EmailOutboxWalSlotHealth,
  type InsertEmailDeliveryRequestInput,
} from './email-delivery-request.types';
export {
  EMAIL_PAYLOAD_CIPHER,
  EnvelopeCipherError,
  type EmailPayloadCipherPort,
} from './email-payload-cipher.port';

export const EMAIL_NOTICE_RESOLVERS = Symbol('EMAIL_NOTICE_RESOLVERS');

export const emailDeliveryTransactionBrand: unique symbol = Symbol(
  'EMAIL_DELIVERY_TRANSACTION',
);

/** Opaque capability for the caller-owned PostgreSQL transaction. */
export interface EmailDeliveryTransaction {
  readonly [emailDeliveryTransactionBrand]?: unknown;
}

/**
 * The only way an Email Delivery Request is written. The outbox table belongs
 * to this module (ADR-0074), so another module that commits a request with its
 * own mutation goes through this port rather than holding a copy of the insert,
 * which would drift the first time the table changed.
 */
export interface EmailDeliveryRequestWriterPort {
  reserveAuthenticationEmailRecipient(
    transaction: EmailDeliveryTransaction,
    input: { readonly email: string; readonly now: Date },
  ): Promise<boolean>;
  insert(
    transaction: EmailDeliveryTransaction,
    input: InsertEmailDeliveryRequestInput,
  ): Promise<void>;
  /**
   * The still-queued, unclaimed requests of one kind, for a caller that must
   * decide from their payloads which of them its own withdrawal supersedes
   * (#1098). Their ciphertexts are returned unopened; the caller owns the
   * payload's meaning.
   */
  queuedPayloadCiphertexts(
    transaction: EmailDeliveryTransaction,
    input: { readonly kind: EmailDeliveryKind },
  ): Promise<
    readonly { readonly id: string; readonly payloadCiphertext: string }[]
  >;
  /**
   * Cancels requests no dispatch has claimed, recording why. A claim in flight
   * is left to finish: its own dispatch decides the row's outcome.
   */
  cancelQueued(
    transaction: EmailDeliveryTransaction,
    input: {
      readonly ids: readonly string[];
      readonly reason: EmailDeliveryCancelReason;
      readonly cancelledAt: Date;
    },
  ): Promise<void>;
}

export const EMAIL_DELIVERY_REQUEST_WRITER = Symbol(
  'EMAIL_DELIVERY_REQUEST_WRITER',
);

/**
 * The `edr_` namespace, bound once by the module so a use case receives a
 * mint function instead of importing one. Mints from the caller's `now`, so
 * the id a request is committed with carries the same instant as its row.
 */
export const EMAIL_DELIVERY_ID = Symbol('EMAIL_DELIVERY_ID');
