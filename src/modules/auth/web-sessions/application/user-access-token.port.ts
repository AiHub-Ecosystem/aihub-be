export interface IssuedUserAccessToken {
  readonly token: string;
  readonly expiresIn: number;
}

export interface UserAccessTokenIssuerPort {
  issue(userId: string): Promise<IssuedUserAccessToken>;
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
}

export interface UserAccessTokenVerifierPort {
  verify(token: string): Promise<VerifiedUserAccessToken>;
}

export const USER_ACCESS_TOKEN_ISSUER = Symbol('USER_ACCESS_TOKEN_ISSUER');
export const USER_ACCESS_TOKEN_VERIFIER = Symbol('USER_ACCESS_TOKEN_VERIFIER');
