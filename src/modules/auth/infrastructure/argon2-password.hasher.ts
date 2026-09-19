import argon2 from 'argon2';

import type { PasswordHasherPort } from '../application/password-hasher.port';

export const ARGON2ID_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
  saltLength: 16,
  hashLength: 32,
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
