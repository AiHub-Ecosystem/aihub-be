export interface RevokeUserAccessTokenPort {
  revoke(input: {
    readonly callerUserId: string;
    readonly token: string;
  }): Promise<void>;
}

export const REVOKE_USER_ACCESS_TOKEN = Symbol('REVOKE_USER_ACCESS_TOKEN');
