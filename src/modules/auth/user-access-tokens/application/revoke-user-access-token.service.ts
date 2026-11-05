import { invalidUserAccessToken } from '@/modules/auth/shared/application/local-auth-errors';
import type { UserAccessTokenVerifierPort } from '@/modules/auth/web-sessions/application/user-access-token.port';
import type { RevokeUserAccessTokenPort } from './revoke-user-access-token.port';
import type { UserAccessTokenRevocationRecordPort } from './user-access-token-revocation-record.port';

export class RevokeUserAccessTokenService implements RevokeUserAccessTokenPort {
  constructor(
    private readonly verifier: UserAccessTokenVerifierPort,
    private readonly revocations: UserAccessTokenRevocationRecordPort,
  ) {}

  async revoke(input: {
    readonly callerUserId: string;
    readonly token: string;
  }): Promise<void> {
    const target = await this.verifier.verify(input.token);
    if (target.userId !== input.callerUserId) {
      throw invalidUserAccessToken();
    }
    await this.revocations.revoke({
      issuer: target.issuer,
      jti: target.jti,
      effectiveExpiresAt: target.validUntil,
    });
  }
}
