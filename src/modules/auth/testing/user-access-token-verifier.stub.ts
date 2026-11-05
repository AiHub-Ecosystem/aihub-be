import type { UserAccessTokenRevocationRecordPort } from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import type { VerifiedUserAccessToken } from '@/modules/auth/web-sessions/application/user-access-token.port';

export const NO_USER_ACCESS_TOKEN_REVOCATIONS: UserAccessTokenRevocationRecordPort =
  {
    revoke: async () => undefined,
    isRevoked: async () => false,
  };

export function verifiedUserAccessToken(
  userId: string,
  jti: string,
): VerifiedUserAccessToken {
  const expiresAt = new Date(Date.now() + 900_000);
  return {
    userId,
    issuer: 'https://api.test.aihub.example.com',
    jti,
    expiresAt,
    validUntil: new Date(expiresAt.getTime() + 60_000),
  };
}
