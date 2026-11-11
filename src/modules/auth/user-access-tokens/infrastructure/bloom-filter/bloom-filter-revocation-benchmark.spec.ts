import { performance } from 'node:perf_hooks';
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

describe('Bloom Filter Revocation Benchmark (AC #1252)', () => {
  it('demonstrates > 40% throughput increase and 0 network calls during steady-state auth', async () => {
    const sampleSize = 50;
    const tokens = Array.from({ length: sampleSize }, (_, i) => ({
      issuer: 'https://api.aihub.example.com',
      jti: `active_token_jti_${i}`,
      now: new Date(),
    }));

    // Baseline: Direct network call per token verification
    const baselineStore = new SimulatedNetworkRevocationStore();
    let baselinePassed = 0;
    const baselineStart = performance.now();
    for (const token of tokens) {
      if (!(await baselineStore.isRevoked(token))) {
        baselinePassed++;
      }
    }
    const baselineDuration = performance.now() - baselineStart;
    const baselineThroughput = (sampleSize / baselineDuration) * 1_000;

    // Canva In-Process Bloom Filter Adapter
    const bloomStore = new SimulatedNetworkRevocationStore();
    const filter = new InProcessBloomFilter({
      capacity: 100_000,
      falsePositiveRate: 0.00001,
    });
    const adapter = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying: bloomStore,
      bloomFilter: filter,
    });

    let bloomPassed = 0;
    const bloomStart = performance.now();
    for (const token of tokens) {
      if (!(await adapter.isRevoked(token))) {
        bloomPassed++;
      }
    }
    const bloomDuration = performance.now() - bloomStart;
    const bloomThroughput = (sampleSize / bloomDuration) * 1_000;

    // Verify all tokens correctly verified
    expect(baselinePassed).toBe(sampleSize);
    expect(bloomPassed).toBe(sampleSize);

    // AC 3 Requirement 1: Zero network commands executed during steady-state auth
    expect(bloomStore.networkCallCount).toBe(0);
    expect(baselineStore.networkCallCount).toBe(sampleSize);

    // AC 3 Requirement 2: Authenticated throughput increases by > 40%
    const throughputIncreasePercent =
      ((bloomThroughput - baselineThroughput) / baselineThroughput) * 100;

    expect(throughputIncreasePercent).toBeGreaterThan(40);

    // AC 1 Requirement: Memory footprint under 1MB RAM
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
