import { createHash, randomBytes } from 'node:crypto';

import { ulid } from 'ulid';

import type {
  IssuedVerificationToken,
  VerificationTokenPort,
} from '../application/verification-token.port';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export class CryptoVerificationToken implements VerificationTokenPort {
  issue(now: Date): IssuedVerificationToken {
    const raw = randomBytes(32).toString('base64url');
    return {
      id: `evt_${ulid(now.getTime())}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    };
  }

  hash(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }
}
