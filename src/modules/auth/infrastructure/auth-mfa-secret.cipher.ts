import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type {
  AuthMfaCipherPort,
  AuthMfaKeyring,
} from '@/modules/auth/application/auth-mfa-repository.port';

type ReadFile = (path: string) => string;

export interface AuthMfaCipherOptions {
  readonly source: string | undefined;
  readonly secretsFile: string | undefined;
  readonly values: Readonly<Record<string, string | undefined>>;
  readonly readFile?: ReadFile;
}

export class AuthMfaCipher implements AuthMfaCipherPort {
  private readonly keys: Readonly<Record<string, Buffer>>;
  private readonly keyId: string;

  constructor(keyring: AuthMfaKeyring) {
    const keys = Object.create(null) as Record<string, Buffer>;
    for (const [id, encoded] of Object.entries(keyring.keys)) {
      const key = Buffer.from(encoded, 'base64');
      if (
        !/^[A-Za-z0-9_-]{1,64}$/u.test(id) ||
        key.length !== 32 ||
        key.toString('base64') !== encoded
      ) {
        throw new Error('Auth MFA keyring is invalid');
      }
      keys[id] = key;
    }
    if (keys[keyring.currentKeyId] === undefined) {
      throw new Error('Auth MFA current key is unavailable');
    }
    this.keys = Object.freeze(keys);
    this.keyId = keyring.currentKeyId;
  }

  encrypt(
    plaintext: string,
    binding: { readonly userId: string; readonly factorId: string },
  ): { readonly keyId: string; readonly ciphertext: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys[this.keyId]!, iv);
    cipher.setAAD(Buffer.from(`${binding.userId}:${binding.factorId}`, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return {
      keyId: this.keyId,
      ciphertext: [iv, cipher.getAuthTag(), ciphertext]
        .map((part) => part.toString('base64url'))
        .join('.'),
    };
  }

  decrypt(
    keyId: string,
    envelope: string,
    binding: { readonly userId: string; readonly factorId: string },
  ): string {
    const key = this.keys[keyId];
    const parts = envelope.split('.');
    if (key === undefined || parts.length !== 3) {
      throw new Error('Auth MFA ciphertext is invalid');
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(parts[0]!, 'base64url'),
      );
      decipher.setAAD(
        Buffer.from(`${binding.userId}:${binding.factorId}`, 'utf8'),
      );
      decipher.setAuthTag(Buffer.from(parts[1]!, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(parts[2]!, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Auth MFA ciphertext is invalid');
    }
  }
}

export function createAuthMfaCipher(
  options: AuthMfaCipherOptions,
): AuthMfaCipher {
  return new AuthMfaCipher(loadKeyring(options));
}

function loadKeyring(options: AuthMfaCipherOptions): AuthMfaKeyring {
  if (options.source === 'env') {
    const currentKeyId = options.values.AIHUB_AUTH_MFA_CURRENT_KEY_ID?.trim();
    const rawKeys = options.values.AIHUB_AUTH_MFA_KEYS;
    if (!currentKeyId || !rawKeys)
      throw new Error('Auth MFA keyring is incomplete');
    let keys: unknown;
    try {
      keys = JSON.parse(rawKeys);
    } catch {
      throw new Error('Auth MFA keyring is invalid');
    }
    if (!isStringRecord(keys)) throw new Error('Auth MFA keyring is invalid');
    return { currentKeyId, keys };
  }

  const path = options.secretsFile?.trim();
  if (!path) throw new Error('AIHUB_AUTH_MFA_SECRETS_FILE is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse((options.readFile ?? defaultReadFile)(path));
  } catch {
    throw new Error('Auth MFA secret file is invalid');
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => !['current_key_id', 'keys'].includes(key))
  ) {
    throw new Error('Auth MFA secret file is invalid');
  }
  if (
    typeof parsed.current_key_id !== 'string' ||
    !isStringRecord(parsed.keys)
  ) {
    throw new Error('Auth MFA secret file is invalid');
  }
  return { currentKeyId: parsed.current_key_id, keys: parsed.keys };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}
