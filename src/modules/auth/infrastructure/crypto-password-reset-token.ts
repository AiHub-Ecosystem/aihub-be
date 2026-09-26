import { createHash, randomBytes } from 'node:crypto';

import { monotonicFactory } from 'ulid';

import type {
  IssuedPasswordResetToken,
  PasswordResetTokenPort,
} from '../application/password-reset-token.port';

const TOKEN_TTL_MS = 60 * 60 * 1000;
/** Same-millisecond `prt_` order follows mint order within this process only. */
const nextPasswordResetTokenId = monotonicFactory();

export class CryptoPasswordResetToken implements PasswordResetTokenPort {
  issue(now: Date): IssuedPasswordResetToken {
    const raw = randomBytes(32).toString('base64url');
    return {
      id: `prt_${nextPasswordResetTokenId(now.getTime())}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    };
  }

  hash(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }
}
