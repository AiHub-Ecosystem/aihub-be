export interface UserAccessTokenRevocationRecordPort {
  revoke(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly effectiveExpiresAt: Date;
  }): Promise<void>;
  isRevoked(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly now: Date;
  }): Promise<boolean>;
}

export const USER_ACCESS_TOKEN_REVOCATION_RECORD = Symbol(
  'USER_ACCESS_TOKEN_REVOCATION_RECORD',
);
