import type { IssuedUserAccessToken } from './user-access-token.port';

export interface CreatedWebSession {
  readonly token: string;
  readonly expiresAt: Date;
}

/** Use cases for a BFF already authenticated by the presentation boundary. */
export interface WebSessionServicePort {
  createWebSession(
    input: { readonly email: string; readonly password: string },
    ip: string,
  ): Promise<CreatedWebSession>;
  /**
   * Verification Sign-in. Answers the Web Session when the Signup Browser
   * Binding matched and this token's one claim was won, and `undefined` when
   * the email was verified but no session was granted — which is the same
   * bodyless `204` the browser-facing verify route answers.
   */
  createWebSessionFromVerification(input: {
    readonly token: string;
    readonly browserBinding: string | undefined;
  }): Promise<CreatedWebSession | undefined>;
  /**
   * Trade a Web Session for a User Access JWT. `token` is `undefined` when the
   * request carried the credential somewhere this route refuses to read it
   * from, which is one generic failure like any other unusable session.
   */
  exchangeWebSession(
    input: { readonly token: string | undefined },
    ip: string,
  ): Promise<IssuedUserAccessToken>;
  /**
   * End the one Web Session the caller presented. `token` is `undefined` when
   * the request carried the credential somewhere this route refuses to read it
   * from.
   *
   * Nothing here is a session failure, so nothing here is reported: a valid,
   * revoked, unknown, expired, and malformed token all answer one bodyless
   * `204`. Only a store that could not record the revocation answers `503`,
   * because "could not end it" and "already ended" are different answers for a
   * BFF clearing a cookie.
   */
  revokeWebSession(input: {
    readonly token: string | undefined;
  }): Promise<void>;
}

export const WEB_SESSION_SERVICE = Symbol('WEB_SESSION_SERVICE');
