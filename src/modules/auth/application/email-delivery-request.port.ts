export type EmailDeliveryKind =
  | 'verification_email'
  | 'password_reset_email'
  | 'organization_invite_email';

/**
 * What a worker needs once it claims a request: the inputs the matching
 * `EmailSenderPort` call takes. It exists only inside the ciphertext, which is
 * why the expiry is an ISO string rather than a `Date`.
 */
export interface EmailDeliveryPayload {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface InsertEmailDeliveryRequestInput {
  readonly id: string;
  readonly kind: EmailDeliveryKind;
  readonly payloadCiphertext: string;
  readonly createdAt: Date;
}

/**
 * The only way an Email Delivery Request's payload can be sealed and read back.
 * A worker that claims a row resolves the key version from the envelope itself.
 */
export interface EmailPayloadCipher {
  encrypt(plaintext: string): string;
  decrypt(envelope: string): string;
}

export const EMAIL_PAYLOAD_CIPHER = Symbol('EMAIL_PAYLOAD_CIPHER');
