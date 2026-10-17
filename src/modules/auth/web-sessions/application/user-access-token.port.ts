export interface IssuedUserAccessToken {
  readonly token: string;
  readonly expiresIn: number;
}

export interface UserAccessTokenIssuerPort {
  issue(userId: string): Promise<IssuedUserAccessToken>;
}

export interface VerifiedUserAccessToken {
  readonly userId: string;
  readonly jti: string;
}

export interface UserAccessTokenVerifierPort {
  verify(token: string): Promise<VerifiedUserAccessToken>;
}

export const USER_ACCESS_TOKEN_ISSUER = Symbol('USER_ACCESS_TOKEN_ISSUER');
export const USER_ACCESS_TOKEN_VERIFIER = Symbol('USER_ACCESS_TOKEN_VERIFIER');
