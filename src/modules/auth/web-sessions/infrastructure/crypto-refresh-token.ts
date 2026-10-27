import { monotonicFactory } from 'ulid';

import { opaqueTokenIssuer } from '@/common/security/opaque-token-issuer';
import type {
  IssuedRefreshToken,
  RefreshTokenIssuerPort,
} from '@/modules/auth/web-sessions/application/refresh-token.port';
import { SESSION_LIFETIME_MS } from '@/modules/auth/web-sessions/application/web-session-policy';

/** Same-millisecond order, limited to this process. */
const nextRefreshTokenFamilyId = monotonicFactory();

// Refresh tokens are the one issuer with a second independent identifier:
// `familyId` is minted here and reused verbatim on rotation, so a rotated
// token stays in the family its predecessor can revoke. The other issuers
// (verification, password-reset, Organization invitation) have no such
// grouping and come from `opaqueTokenIssuer` directly.
export class CryptoRefreshToken implements RefreshTokenIssuerPort {
  private readonly tokens = opaqueTokenIssuer('rft_', SESSION_LIFETIME_MS);

  issue(
    now: Date,
    familyId = `rfs_${nextRefreshTokenFamilyId(now.getTime())}`,
  ): IssuedRefreshToken {
    return {
      ...this.tokens.issue(now),
      familyId,
    };
  }

  hash(raw: string): string {
    return this.tokens.hash(raw);
  }
}
