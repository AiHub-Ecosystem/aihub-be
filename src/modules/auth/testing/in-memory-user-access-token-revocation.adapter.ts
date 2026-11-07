import { databaseUnavailableError } from '@/common/postgres/postgres-unavailable-error';
import type { UserAccessTokenRevocationRecordPort } from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';

export class InMemoryUserAccessTokenRevocationAdapter
  implements UserAccessTokenRevocationRecordPort
{
  readonly records = new Map<
    string,
    {
      readonly issuer: string;
      readonly jti: string;
      readonly effectiveExpiresAt: Date;
    }
  >();
  failLookup = false;
  failRevoke = false;

  async revoke(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly effectiveExpiresAt: Date;
  }): Promise<void> {
    if (this.failRevoke) throw databaseUnavailableError();
    const key = JSON.stringify([input.issuer, input.jti]);
    const existing = this.records.get(key);
    this.records.set(
      key,
      existing === undefined ||
        existing.effectiveExpiresAt < input.effectiveExpiresAt
        ? input
        : existing,
    );
  }

  async isRevoked(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly now: Date;
  }): Promise<boolean> {
    if (this.failLookup) throw databaseUnavailableError();
    const record = this.records.get(JSON.stringify([input.issuer, input.jti]));
    return record !== undefined && record.effectiveExpiresAt >= input.now;
  }

  async listActiveRevocations(
    now: Date = new Date(),
  ): Promise<readonly { readonly issuer: string; readonly jti: string }[]> {
    if (this.failLookup) throw databaseUnavailableError();
    const active: Array<{ readonly issuer: string; readonly jti: string }> = [];
    for (const record of this.records.values()) {
      if (record.effectiveExpiresAt >= now) {
        active.push({ issuer: record.issuer, jti: record.jti });
      }
    }
    return active;
  }

  reset(): void {
    this.records.clear();
    this.failLookup = false;
    this.failRevoke = false;
  }
}
