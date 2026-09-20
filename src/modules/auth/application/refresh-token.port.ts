export interface IssuedRefreshToken {
  readonly id: string;
  readonly familyId: string;
  readonly raw: string;
  readonly hash: string;
  readonly expiresAt: Date;
}

export interface RefreshTokenIssuerPort {
  issue(now: Date, familyId?: string): IssuedRefreshToken;
  hash(raw: string): string;
}

export const REFRESH_TOKEN_ISSUER = Symbol('REFRESH_TOKEN_ISSUER');
