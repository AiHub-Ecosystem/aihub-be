import type { UserAccessTokenRevocationRecordPort } from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import { BloomFilterUserAccessTokenRevocationAdapter } from './bloom-filter-user-access-token-revocation.adapter';
import { InProcessBloomFilter } from './in-process-bloom-filter';

class RecordingRevocationAdapter
  implements UserAccessTokenRevocationRecordPort
{
  readonly isRevokedCalls: Array<{
    readonly issuer: string;
    readonly jti: string;
    readonly now: Date;
  }> = [];
  readonly revokeCalls: Array<{
    readonly issuer: string;
    readonly jti: string;
    readonly effectiveExpiresAt: Date;
  }> = [];
  readonly revokedSet = new Set<string>();

  async revoke(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly effectiveExpiresAt: Date;
  }): Promise<void> {
    this.revokeCalls.push(input);
    this.revokedSet.add(JSON.stringify([input.issuer, input.jti]));
  }

  async isRevoked(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly now: Date;
  }): Promise<boolean> {
    this.isRevokedCalls.push(input);
    return this.revokedSet.has(JSON.stringify([input.issuer, input.jti]));
  }
}

class FakeRedisClient {
  readonly published: Array<{
    readonly channel: string;
    readonly message: string;
  }> = [];
  readonly subscribedChannels: string[] = [];
  private messageHandler?: (channel: string, message: string) => void;
  publishError?: Error;

  async publish(channel: string, message: string): Promise<number> {
    if (this.publishError) throw this.publishError;
    this.published.push({ channel, message });
    return 1;
  }

  async subscribe(channel: string): Promise<string> {
    this.subscribedChannels.push(channel);
    return 'OK';
  }

  async unsubscribe(channel: string): Promise<string> {
    const idx = this.subscribedChannels.indexOf(channel);
    if (idx !== -1) this.subscribedChannels.splice(idx, 1);
    return 'OK';
  }

  on(event: string, handler: (channel: string, message: string) => void): void {
    if (event === 'message') {
      this.messageHandler = handler;
    }
  }

  emitMessage(channel: string, message: string): void {
    this.messageHandler?.(channel, message);
  }
}

describe('BloomFilterUserAccessTokenRevocationAdapter', () => {
  let underlying: RecordingRevocationAdapter;
  let bloomFilter: InProcessBloomFilter;
  let mockPublisher: FakeRedisClient;
  let mockSubscriber: FakeRedisClient;
  let adapter: BloomFilterUserAccessTokenRevocationAdapter;

  beforeEach(() => {
    underlying = new RecordingRevocationAdapter();
    bloomFilter = new InProcessBloomFilter({
      capacity: 10_000,
      falsePositiveRate: 0.00001,
    });
    mockPublisher = new FakeRedisClient();
    mockSubscriber = new FakeRedisClient();

    adapter = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying,
      bloomFilter,
      redisPublisher: mockPublisher,
      redisSubscriber: mockSubscriber,
    });
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('bypasses underlying store and returns false when token not in filter', async () => {
    const isRevoked = await adapter.isRevoked({
      issuer: 'aihub_test',
      jti: 'valid_active_jti_123',
      now: new Date(),
    });

    expect(isRevoked).toBe(false);
    expect(underlying.isRevokedCalls).toHaveLength(0);
  });

  it('revokes token, updates local filter, and publishes to Redis Pub/Sub', async () => {
    const input = {
      issuer: 'aihub_test',
      jti: 'revoked_jti_456',
      effectiveExpiresAt: new Date(Date.now() + 3600_000),
    };

    await adapter.revoke(input);

    expect(underlying.revokeCalls).toEqual([input]);
    expect(mockPublisher.published).toEqual([
      {
        channel: 'aihub:auth:token-revocations',
        message: JSON.stringify({
          issuer: input.issuer,
          jti: input.jti,
          effectiveExpiresAt: input.effectiveExpiresAt.toISOString(),
        }),
      },
    ]);

    // Filter now contains the token, so isRevoked queries underlying and finds it revoked
    const isRevoked = await adapter.isRevoked({
      issuer: input.issuer,
      jti: input.jti,
      now: new Date(),
    });

    expect(isRevoked).toBe(true);
    expect(underlying.isRevokedCalls).toHaveLength(1);
  });

  it('falls back to underlying store on false positive and returns false if not actually revoked', async () => {
    // Manually add key to filter to simulate a false positive
    bloomFilter.add(JSON.stringify(['aihub_test', 'fp_jti_789']));

    // Key is in bloom filter, but not in underlying.revokedSet
    const isRevoked = await adapter.isRevoked({
      issuer: 'aihub_test',
      jti: 'fp_jti_789',
      now: new Date(),
    });

    expect(isRevoked).toBe(false);
    expect(underlying.isRevokedCalls).toHaveLength(1);
  });

  it('receives revocation broadcast from another instance and adds to local filter', async () => {
    const remoteRevocation = {
      issuer: 'aihub_test',
      jti: 'remote_jti_999',
      effectiveExpiresAt: new Date().toISOString(),
    };

    // Mark as revoked in underlying storage
    underlying.revokedSet.add(
      JSON.stringify([remoteRevocation.issuer, remoteRevocation.jti]),
    );

    mockSubscriber.emitMessage(
      'aihub:auth:token-revocations',
      JSON.stringify(remoteRevocation),
    );

    const isRevoked = await adapter.isRevoked({
      issuer: remoteRevocation.issuer,
      jti: remoteRevocation.jti,
      now: new Date(),
    });

    expect(isRevoked).toBe(true);
    expect(underlying.isRevokedCalls).toHaveLength(1);
  });

  it('tolerates Redis publish error without failing revocation', async () => {
    mockPublisher.publishError = new Error('Redis connection lost');

    const input = {
      issuer: 'aihub_test',
      jti: 'revoked_offline_jti',
      effectiveExpiresAt: new Date(Date.now() + 3600_000),
    };

    await expect(adapter.revoke(input)).resolves.toBeUndefined();
    expect(underlying.revokeCalls).toEqual([input]);

    const isRevoked = await adapter.isRevoked({
      issuer: input.issuer,
      jti: input.jti,
      now: new Date(),
    });
    expect(isRevoked).toBe(true);
  });
});
