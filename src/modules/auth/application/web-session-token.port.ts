/**
 * One issued Web Session token: 32 CSPRNG bytes, base64url.
 *
 * Unlike a Refresh Token it does not rotate and belongs to no token family;
 * the row that holds it is `web_sessions`, keyed by `hash`.
 */
export interface IssuedWebSessionToken {
  readonly raw: string;
  /** The only form AIHUB persists. */
  readonly hash: string;
  readonly expiresAt: Date;
}

export interface WebSessionTokenIssuerPort {
  issue(now: Date): IssuedWebSessionToken;
}

export const WEB_SESSION_TOKEN_ISSUER = Symbol('WEB_SESSION_TOKEN_ISSUER');
