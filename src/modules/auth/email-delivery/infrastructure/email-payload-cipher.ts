import type {
  EmailPayloadCipherPort,
  EmailPayloadContext,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import {
  EmailPayloadUnknownKeyVersionError,
  EnvelopeCipherError,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';
import { EnvelopeCipher } from './envelope-cipher';

// v1 carries no associated data. v2 authenticates the request the payload
// belongs to. Both are read; only v1 is written until every instance can read
// v2 (docs/operations/email-outbox.md, "Release order", #439), then
// `WRITE_BOUND` flips and v1 drains.
const WRITE_BOUND = false;
const LEGACY_VERSION = 'v1';
const BOUND_VERSION = 'v2';

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

/** What a v2 envelope authenticates: the request it belongs to, id then kind. */
function boundTo(context: EmailPayloadContext): Buffer {
  return Buffer.from(`${context.id}\n${context.kind}`, 'utf8');
}

export function createEmailPayloadCipher(
  secrets: EmailOutboxRuntimeSecrets,
): EmailPayloadCipherPort {
  const keyring = { keys: secrets.keys, currentKeyId: secrets.currentKeyId };
  const legacy = new EnvelopeCipher(
    keyring,
    'self-describing',
    LEGACY_VERSION,
    EMAIL_MESSAGES,
  );
  const bound = new EnvelopeCipher(
    keyring,
    'self-describing',
    BOUND_VERSION,
    EMAIL_MESSAGES,
  );
  return {
    encrypt(plaintext: string, context: EmailPayloadContext): string {
      return WRITE_BOUND
        ? bound.seal(plaintext, boundTo(context))
        : legacy.seal(plaintext);
    },
    decrypt(envelope: string, context: EmailPayloadContext): string {
      try {
        return envelope.startsWith(`${LEGACY_VERSION}.`)
          ? legacy.open(envelope, undefined)
          : bound.open(envelope, undefined, boundTo(context));
      } catch (error) {
        if (
          error instanceof EnvelopeCipherError &&
          error.kind === 'unknown-key'
        ) {
          throw new EmailPayloadUnknownKeyVersionError();
        }
        throw error;
      }
    },
  };
}
