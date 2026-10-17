import argon2 from 'argon2';

import { ARGON2ID_PARAMETERS } from '@/modules/auth/local-credentials/application/argon2id-parameters';
import type { PasswordHasherPort } from '@/modules/auth/local-credentials/application/password-hasher.port';

export const ARGON2ID_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  ...ARGON2ID_PARAMETERS,
});

export class Argon2PasswordHasher implements PasswordHasherPort {
  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2ID_OPTIONS);
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    try {
      return await argon2.verify(encodedHash, password);
    } catch {
      return false;
    }
  }
}
