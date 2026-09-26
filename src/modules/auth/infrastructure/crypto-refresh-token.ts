import { createHash, randomBytes } from 'node:crypto';

import { monotonicFactory } from 'ulid';

import type {
  IssuedRefreshToken,
  RefreshTokenIssuerPort,
} from '../application/refresh-token.port';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Independent same-millisecond mint-order sequences, limited to this process. */
const nextRefreshTokenFamilyId = monotonicFactory();
const nextRefreshTokenId = monotonicFactory();

export class CryptoRefreshToken implements RefreshTokenIssuerPort {
  issue(
    now: Date,
    familyId = `rfs_${nextRefreshTokenFamilyId(now.getTime())}`,
  ): IssuedRefreshToken {
    const raw = randomBytes(32).toString('base64url');
    return {
      id: `rft_${nextRefreshTokenId(now.getTime())}`,
      familyId,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    };
  }

  hash(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }
}
