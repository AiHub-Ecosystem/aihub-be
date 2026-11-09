import { Buffer } from 'node:buffer';
import { internalError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import { readUtf8File } from '@/common/security/secret-document';

import { EnvelopeCipherError } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type {
  AuthMfaCipherPort,
  AuthMfaKeyring,
} from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import { EnvelopeCipher } from '@/modules/auth/shared/infrastructure/envelope-cipher';

export interface AuthMfaCipherOptions {
  readonly source: string | undefined;
  readonly secretsFile: string | undefined;
  readonly values: Readonly<Record<string, string | undefined>>;
  readonly readFile?: (path: string) => string;
}

const MFA_MESSAGES = {
  keyring: 'Auth MFA keyring is invalid',
  keyId: 'Auth MFA keyring is invalid',
  keyMaterial: 'Auth MFA keyring is invalid',
  currentKey: 'Auth MFA keyring is invalid',
  missingKeys: 'Auth MFA keyring is invalid',
  currentNotProvisioned: 'Auth MFA keyring is invalid',
  malformed: 'Auth MFA ciphertext is invalid',
  unknownKey: 'Auth MFA ciphertext is invalid',
  unreadable: 'Auth MFA ciphertext is invalid',
} as const;

export class AuthMfaCipher implements AuthMfaCipherPort {
  private readonly cipher: EnvelopeCipher;

  constructor(keyring: AuthMfaKeyring) {
    this.cipher = new EnvelopeCipher(keyring, 'compact', 'v1', MFA_MESSAGES);
  }

  encrypt(
    plaintext: string,
    binding: { readonly userId: string; readonly factorId: string },
  ): { readonly keyId: string; readonly ciphertext: string } {
    const aad = Buffer.from(`${binding.userId}:${binding.factorId}`, 'utf8');
    return {
      keyId: this.cipher.currentKeyId,
      ciphertext: this.cipher.seal(plaintext, aad),
    };
  }

  decrypt(
    keyId: string,
    envelope: string,
    binding: { readonly userId: string; readonly factorId: string },
  ): string {
    const aad = Buffer.from(`${binding.userId}:${binding.factorId}`, 'utf8');
    try {
      return this.cipher.open(envelope, keyId, aad);
    } catch (error) {
      const kind =
        error instanceof EnvelopeCipherError ? error.kind : 'unreadable';
      throw new EnvelopeCipherError(kind, 'Auth MFA ciphertext is invalid');
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
    const currentKeyId =
      options.values['AIHUB_AUTH_MFA_CURRENT_KEY_ID']?.trim();
    const rawKeys = options.values['AIHUB_AUTH_MFA_KEYS'];
    if (!currentKeyId || !rawKeys)
      throw internalError('Auth MFA keyring is incomplete');
    let keys: unknown;
    try {
      keys = JSON.parse(rawKeys);
    } catch {
      throw internalError('Auth MFA keyring is invalid');
    }
    if (!isStringRecord(keys))
      throw internalError('Auth MFA keyring is invalid');
    return { currentKeyId, keys };
  }

  const path = options.secretsFile?.trim();
  if (!path) throw internalError('AIHUB_AUTH_MFA_SECRETS_FILE is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse((options.readFile ?? readUtf8File)(path));
  } catch {
    throw internalError('Auth MFA secret file is invalid');
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => !['current_key_id', 'keys'].includes(key))
  ) {
    throw internalError('Auth MFA secret file is invalid');
  }
  if (
    typeof parsed['current_key_id'] !== 'string' ||
    !isStringRecord(parsed['keys'])
  ) {
    throw internalError('Auth MFA secret file is invalid');
  }
  return { currentKeyId: parsed['current_key_id'], keys: parsed['keys'] };
}

function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}
