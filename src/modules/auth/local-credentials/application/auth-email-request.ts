import type { AuthEmailDeliveryPayload } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { QueueEmailDeliveryRequestInput } from '@/modules/auth/email-delivery/application/email-outbox.port';

/**
 * The per-caller, per-address ceiling on authentication emails. Registration,
 * resend, and password recovery spend the same budget, so it lives with the
 * request they all build rather than in one of them.
 */
export const AUTH_EMAIL_REQUEST_LIMIT = {
  scope: 'auth_email_request',
  limit: 3,
  windowMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * The durable handoff (ADR-0074). The recipient and token reach the row only
 * as authenticated ciphertext, under a key version the worker can still
 * resolve when it claims the row.
 */
export function emailDeliveryRequest(
  kind: 'verification_email' | 'password_reset_email',
  payload: AuthEmailDeliveryPayload,
  now: Date,
): QueueEmailDeliveryRequestInput {
  return { kind, payload, createdAt: now };
}
