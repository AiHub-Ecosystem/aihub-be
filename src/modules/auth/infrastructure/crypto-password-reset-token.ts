import { createHash, randomBytes } from 'node:crypto';

import { ulid } from 'ulid';

import type {
  IssuedPasswordResetToken,
  PasswordResetTokenPort,
} from '../application/password-reset-token.port';

const TOKEN_TTL_MS = 60 * 60 * 1000;

export class CryptoPasswordResetToken implements PasswordResetTokenPort {
  issue(now: Date): IssuedPasswordResetToken {
    const raw = randomBytes(32).toString('base64url');
    return {
      id: `prt_${ulid(now.getTime())}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    };
  }

  hash(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }
}
