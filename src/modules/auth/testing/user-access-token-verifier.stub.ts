import type { UserAccessTokenRevocationRecordPort } from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import type { VerifiedUserAccessToken } from '@/modules/auth/web-sessions/application/user-access-token.port';

export const NO_USER_ACCESS_TOKEN_REVOCATIONS: UserAccessTokenRevocationRecordPort =
  {
    revoke: async () => undefined,
    isRevoked: async () => false,
    listActiveRevocations: async () => [],
  };

export function verifiedUserAccessToken(
  userId: string,
  jti: string,
): VerifiedUserAccessToken {
  return {
    userId,
    issuer: 'https://api.test.aihub.example.com',
    jti,
    validUntil: new Date(Date.now() + 960_000),
  };
}
