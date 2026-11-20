import type { EmailDeliveryKind } from './email-kind-handler.registry';

/**
 * The only way an Email Delivery Request's payload can be sealed and read back.
 * A worker that claims a row resolves the key version from the envelope itself.
 * Named for the record it owns, the way every other durable record port is.
 */
export interface EmailPayloadCipherPort {
  encrypt(plaintext: string, context: EmailPayloadContext): string;
  decrypt(envelope: string, context: EmailPayloadContext): string;
}

/**
 * What a sealed payload belongs to. An envelope is authenticated against it, so
 * a ciphertext moved to another row or kind does not open (ADR-0074).
 */
export interface EmailPayloadContext {
  readonly id: string;
  readonly kind: EmailDeliveryKind;
}

/**
 * One failure kind for every AES-256-GCM envelope in the module, so a caller
 * decides what a failure means from its kind rather than from the concrete
 * thrown type. `unknown-key` becomes `key_unavailable`; malformed and
 * unreadable envelopes become `payload_unreadable`.
 */
export type EnvelopeCipherFailureKind =
  | 'malformed'
  | 'unknown-key'
  | 'unreadable';

export class EnvelopeCipherError extends Error {
  constructor(
    readonly kind: EnvelopeCipherFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'EnvelopeCipherError';
  }
}

/**
 * The envelope names a key version this instance no longer holds. The poller
 * treats this as an operator-visible terminal failure, distinct from corruption.
 */
export class EmailPayloadUnknownKeyVersionError extends EnvelopeCipherError {
  constructor() {
    super('unknown-key', 'email outbox key version is unknown');
    this.name = 'EmailPayloadUnknownKeyVersionError';
  }
}

export const EMAIL_PAYLOAD_CIPHER = Symbol('EMAIL_PAYLOAD_CIPHER');
