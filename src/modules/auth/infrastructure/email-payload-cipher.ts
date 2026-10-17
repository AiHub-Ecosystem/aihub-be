import type { EmailPayloadCipherPort } from '@/modules/auth/application/email-delivery-request.port';
import {
  EmailPayloadUnknownKeyVersionError,
  EnvelopeCipherError,
} from '@/modules/auth/application/email-delivery-request.port';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';
import { EnvelopeCipher } from './envelope-cipher';

const ENVELOPE_VERSION = 'v1';

const EMAIL_MESSAGES = {
  keyring: 'email outbox key material is invalid',
  keyId: 'email outbox key id is invalid',
  keyMaterial: 'email outbox key material is invalid',
  currentKey: 'email outbox key id is invalid',
  missingKeys: 'email outbox key material is missing',
  currentNotProvisioned: 'email outbox current key id is not provisioned',
  malformed: 'email outbox envelope is malformed',
  unknownKey: 'email outbox key version is unknown',
  unreadable: 'email outbox envelope is malformed',
} as const;

export function createEmailPayloadCipher(
  secrets: EmailOutboxRuntimeSecrets,
): EmailPayloadCipherPort {
  const cipher = new EnvelopeCipher(
    { keys: secrets.keys, currentKeyId: secrets.currentKeyId },
    'self-describing',
    ENVELOPE_VERSION,
    EMAIL_MESSAGES,
  );
  return {
    encrypt(plaintext: string): string {
      return cipher.seal(plaintext);
    },
    decrypt(envelope: string): string {
      try {
        return cipher.open(envelope, undefined);
      } catch (error) {
        if (error instanceof EnvelopeCipherError) {
          if (error.kind === 'unknown-key') {
            throw new EmailPayloadUnknownKeyVersionError();
          }
          throw new Error(error.message);
        }
        throw error;
      }
    },
  };
}
