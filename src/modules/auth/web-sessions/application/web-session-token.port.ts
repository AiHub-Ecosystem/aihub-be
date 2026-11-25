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
  /**
   * The one digest `issue` stores, exposed so a later request can recognise a
   * raw token AIHUB did not issue here — the exchange lookup, and the
   * per-token rate-limit key.
   */
  hash(raw: string): string;
}

export const WEB_SESSION_TOKEN_ISSUER = Symbol('WEB_SESSION_TOKEN_ISSUER');

/**
 * The minter for a `wbs_`-prefixed Web Session row id. Bound once in the
 * module composition root from the same binding the token issuer uses, so the
 * row's id and its token share one namespace and one clock.
 */
export const WEB_SESSION_ID = Symbol('WEB_SESSION_ID');
