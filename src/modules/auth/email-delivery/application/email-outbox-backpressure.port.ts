import type { EmailDeliveryKind } from './email-delivery-request.port';

export const ADMIT_EMAIL_REQUEST = Symbol('ADMIT_EMAIL_REQUEST');

export type BackpressureEmailKind = Extract<
  EmailDeliveryKind,
  'verification_email' | 'password_reset_email' | 'organization_invite_email'
>;

/**
 * Asked by a route before it queues a credential email. It rejects with a
 * retryable 503 when the outbox cannot deliver within the credential's
 * lifetime, and writes nothing.
 */
export interface AdmitEmailRequestPort {
  admit(kind: BackpressureEmailKind): Promise<void>;
}

export interface EmailOutboxQueueAgePort {
  /**
   * How long the oldest queued request of this kind has waited, in seconds.
   * `undefined` when nothing of this kind is queued or the age is not known.
   */
  oldestQueuedAgeSeconds(kind: EmailDeliveryKind): Promise<number | undefined>;
}
