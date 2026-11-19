import type { DpopProofKeyInput } from './dpop-proof-key';

export interface IssuedUserAccessToken {
  readonly token: string;
  readonly expiresIn: number;
}

export interface UserAccessTokenIssuerPort {
  /**
   * With a `proofKey` the token is bound to that Client proof key through
   * `cnf.jkt`; without one it is an unbound bearer token.
   */
  issue(
    userId: string,
    session?: UserAccessSession,
    proofKey?: DpopProofKeyInput,
  ): Promise<IssuedUserAccessToken>;
}

export type UserAccessSession =
  | { readonly kind: 'refresh'; readonly id: string }
  | { readonly kind: 'web'; readonly id: string };

export interface VerifiedUserAccessToken {
  readonly userId: string;
  readonly issuer: string;
  readonly jti: string;
  readonly validUntil: Date;
  /** Optional until the later release starts writing the session claim. */
  readonly session?: UserAccessSession;
  /** Proof key thumbprint (`cnf.jkt`); absent for an unbound token. */
  readonly jkt?: string;
}

export interface UserAccessTokenVerifierPort {
  verify(token: string): Promise<VerifiedUserAccessToken>;
}

export const USER_ACCESS_TOKEN_ISSUER = Symbol('USER_ACCESS_TOKEN_ISSUER');
export const USER_ACCESS_TOKEN_VERIFIER = Symbol('USER_ACCESS_TOKEN_VERIFIER');
