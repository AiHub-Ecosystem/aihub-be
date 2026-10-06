import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { EmailPayloadCipherPort } from '@/modules/auth/application/email-delivery-request.port';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

const ENVELOPE_VERSION = 'v1';

export function createEmailPayloadCipher(
  secrets: EmailOutboxRuntimeSecrets,
): EmailPayloadCipherPort {
  const keys = validateKeyring(secrets);
  return {
    encrypt(plaintext) {
      const key = keys.get(secrets.currentKeyId);
      if (key === undefined) {
        throw new Error('email outbox current key is unavailable');
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      return [
        ENVELOPE_VERSION,
        secrets.currentKeyId,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },
    decrypt(envelope) {
      const parts = envelope.split('.');
      if (parts[0] !== ENVELOPE_VERSION || parts.length !== 5) {
        throw new Error('email outbox envelope is malformed');
      }
      const key = keys.get(parts[1] as string);
      if (key === undefined) {
        throw new Error('email outbox key version is unknown');
      }
      const iv = Buffer.from(parts[2] as string, 'base64url');
      const tag = Buffer.from(parts[3] as string, 'base64url');
      const ciphertext = Buffer.from(parts[4] as string, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

function validateKeyring(
  secrets: EmailOutboxRuntimeSecrets,
): ReadonlyMap<string, Buffer> {
  const entries = Object.entries(secrets.keys);
  if (entries.length === 0) {
    throw new Error('email outbox key material is missing');
  }
  const ring = new Map<string, Buffer>();
  for (const [keyId, value] of entries) {
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) {
      throw new Error('email outbox key material is invalid');
    }
    ring.set(keyId, key);
  }
  if (!ring.has(secrets.currentKeyId)) {
    throw new Error('email outbox current key id is not provisioned');
  }
  return ring;
}
