import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { EnvelopeCipherError } from '@/modules/auth/application/email-delivery-request.port';

export type EnvelopeLayout = 'compact' | 'self-describing';

export interface EnvelopeKeyring {
  readonly keys: Readonly<Record<string, string>>;
  readonly currentKeyId: string;
}

export interface EnvelopeCipherMessages {
  readonly keyring: string;
  readonly keyId: string;
  readonly keyMaterial: string;
  readonly currentKey: string;
  readonly missingKeys: string;
  readonly currentNotProvisioned: string;
  readonly malformed: string;
  readonly unknownKey: string;
  readonly unreadable: string;
}

const DEFAULT_KEY_ID_RULE = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * One AES-256-GCM envelope for the whole module. The segment layout is the only
 * part that genuinely differs between callers: the MFA secret stores three
 * segments and carries its key id beside them, because MFA factors predate the
 * self-describing envelope, while the email payload stores five and names its own
 * key version. The keyring rule, the key length and the failure kinds are the
 * same everywhere, which is the whole point of having one cipher.
 *
 * A caller that authenticates ciphertext to a subject (the MFA secret is bound
 * to its user and factor) passes that subject's bytes as `aad`; a caller that
 * binds nothing passes nothing. The cipher does not know what the bytes mean.
 */
export class EnvelopeCipher {
  private readonly keys: ReadonlyMap<string, Buffer>;
  readonly currentKeyId: string;
  private readonly layout: EnvelopeLayout;
  private readonly version: string;
  private readonly messages: EnvelopeCipherMessages;

  constructor(
    keyring: EnvelopeKeyring,
    layout: EnvelopeLayout,
    version: string,
    messages: EnvelopeCipherMessages,
  ) {
    this.keys = validateKeyring(keyring, messages);
    this.currentKeyId = keyring.currentKeyId;
    this.layout = layout;
    this.version = version;
    this.messages = messages;
  }

  seal(plaintext: string, aad?: Buffer): string {
    const key = this.keys.get(this.currentKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    if (aad !== undefined) cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const tail = [
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ];
    if (this.layout === 'self-describing') {
      return [this.version, this.currentKeyId, ...tail].join('.');
    }
    return tail.join('.');
  }

  open(
    envelope: string,
    externalKeyId: string | undefined,
    aad?: Buffer,
  ): string {
    const parts = envelope.split('.');
    let keyId: string;
    let ivB64: string;
    let tagB64: string;
    let ciphertextB64: string;

    if (this.layout === 'self-describing') {
      if (parts.length !== 5 || parts[0] !== this.version) {
        throw new EnvelopeCipherError('malformed', this.messages.malformed);
      }
      keyId = parts[1]!;
      ivB64 = parts[2]!;
      tagB64 = parts[3]!;
      ciphertextB64 = parts[4]!;
    } else {
      if (parts.length !== 3) {
        throw new EnvelopeCipherError('malformed', this.messages.malformed);
      }
      if (externalKeyId === undefined) {
        throw new EnvelopeCipherError('malformed', this.messages.malformed);
      }
      keyId = externalKeyId;
      ivB64 = parts[0]!;
      tagB64 = parts[1]!;
      ciphertextB64 = parts[2]!;
    }

    const key = this.keys.get(keyId);
    if (key === undefined) {
      throw new EnvelopeCipherError('unknown-key', this.messages.unknownKey);
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(ivB64, 'base64url'),
      );
      if (aad !== undefined) decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextB64, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new EnvelopeCipherError('unreadable', this.messages.unreadable);
    }
  }
}

function validateKeyring(
  keyring: EnvelopeKeyring,
  messages: EnvelopeCipherMessages,
): ReadonlyMap<string, Buffer> {
  const entries = Object.entries(keyring.keys);
  if (entries.length === 0) {
    throw new EnvelopeCipherError('malformed', messages.missingKeys);
  }
  const ring = new Map<string, Buffer>();
  for (const [id, encoded] of entries) {
    if (!DEFAULT_KEY_ID_RULE.test(id)) {
      throw new EnvelopeCipherError('malformed', messages.keyId);
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) {
      throw new EnvelopeCipherError('malformed', messages.keyMaterial);
    }
    ring.set(id, key);
  }
  if (
    keyring.currentKeyId.length === 0 ||
    !DEFAULT_KEY_ID_RULE.test(keyring.currentKeyId)
  ) {
    throw new EnvelopeCipherError('malformed', messages.keyId);
  }
  if (!ring.has(keyring.currentKeyId)) {
    throw new EnvelopeCipherError('malformed', messages.currentNotProvisioned);
  }
  return ring;
}
