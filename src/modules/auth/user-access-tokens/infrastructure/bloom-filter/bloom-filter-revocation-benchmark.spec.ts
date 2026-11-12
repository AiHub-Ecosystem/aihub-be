import type { UserAccessTokenRevocationRecordPort } from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import { BloomFilterUserAccessTokenRevocationAdapter } from './bloom-filter-user-access-token-revocation.adapter';
import { InProcessBloomFilter } from './in-process-bloom-filter';

class SimulatedNetworkRevocationStore
  implements UserAccessTokenRevocationRecordPort
{
  networkCallCount = 0;
  private readonly revokedTokens = new Set<string>();

  async revoke(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly effectiveExpiresAt: Date;
  }): Promise<void> {
    this.networkCallCount++;
    this.revokedTokens.add(`${input.issuer}:${input.jti}`);
  }

  async isRevoked(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly now: Date;
  }): Promise<boolean> {
    this.networkCallCount++;
    // Simulate realistic network round-trip to Redis / PostgreSQL (~1ms)
    await new Promise((resolve) => setTimeout(resolve, 1));
    return this.revokedTokens.has(`${input.issuer}:${input.jti}`);
  }

  async listActiveRevocations(): Promise<
    readonly { readonly issuer: string; readonly jti: string }[]
  > {
    return [];
  }
}

describe('Bloom Filter Revocation Lookup Contract', () => {
  it('checks the authoritative store for every negative decision', async () => {
    const sampleSize = 50;
    const tokens = Array.from({ length: sampleSize }, (_, i) => ({
      issuer: 'https://api.aihub.example.com',
      jti: `active_token_jti_${i}`,
      now: new Date(),
    }));

    // Bloom misses no longer authorize a token without an authoritative read.
    const bloomStore = new SimulatedNetworkRevocationStore();
    const filter = new InProcessBloomFilter({
      capacity: 100_000,
      falsePositiveRate: 0.00001,
    });
    const adapter = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying: bloomStore,
      bloomFilter: filter,
    });

    for (const token of tokens) {
      await expect(adapter.isRevoked(token)).resolves.toBe(false);
    }
    expect(bloomStore.networkCallCount).toBe(sampleSize);

    // The inactive optimization's allocation remains bounded.
    expect(filter.byteLength).toBeLessThan(1024 * 1024);
  });

  it('correctly identifies revoked tokens with zero false negatives', async () => {
    const underlying = new SimulatedNetworkRevocationStore();
    const filter = new InProcessBloomFilter({
      capacity: 10_000,
      falsePositiveRate: 0.00001,
    });
    const adapter = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying,
      bloomFilter: filter,
    });

    const revokedCount = 50;
    for (let i = 0; i < revokedCount; i++) {
      await adapter.revoke({
        issuer: 'https://api.aihub.example.com',
        jti: `revoked_jti_${i}`,
        effectiveExpiresAt: new Date(Date.now() + 60_000),
      });
    }

    // Every revoked token must return true
    for (let i = 0; i < revokedCount; i++) {
      const isRevoked = await adapter.isRevoked({
        issuer: 'https://api.aihub.example.com',
        jti: `revoked_jti_${i}`,
        now: new Date(),
      });
      expect(isRevoked).toBe(true);
    }
  });
});
