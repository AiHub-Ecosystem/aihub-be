import type {
  IssuedRefreshToken,
  RefreshTokenIssuerPort,
} from '@/modules/auth/web-sessions/application/refresh-token.port';
import type { UserAccessTokenIssuerPort } from '@/modules/auth/web-sessions/application/user-access-token.port';

export interface IssuedSession {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
}

/**
 * The two issuers every session-issuing flow needs, passed together so a use
 * case names one collaborator instead of two.
 */
export interface SessionTokenIssuers {
  readonly accessTokens: UserAccessTokenIssuerPort;
  readonly refreshTokens: RefreshTokenIssuerPort;
}

/**
 * The one way a session reaches a client. Verification Sign-in passes the
 * Refresh Session its claim already stored; login stores it afterwards.
 */
export async function issueSession(
  issuers: SessionTokenIssuers,
  userId: string,
  refreshToken: IssuedRefreshToken,
): Promise<IssuedSession> {
  const accessToken = await issuers.accessTokens.issue(userId, {
    kind: 'refresh',
    id: refreshToken.familyId,
  });
  return {
    accessToken: accessToken.token,
    expiresIn: accessToken.expiresIn,
    refreshToken: refreshToken.raw,
  };
}
