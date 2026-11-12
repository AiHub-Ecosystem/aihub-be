import type { UserAccessTokenRevocationRecordPort } from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import { Logger } from '@nestjs/common';
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

  async listActiveRevocations(
    now: Date = new Date(),
  ): Promise<readonly { readonly issuer: string; readonly jti: string }[]> {
    const active: Array<{ readonly issuer: string; readonly jti: string }> = [];
    for (const call of this.revokeCalls) {
      if (call.effectiveExpiresAt >= now) {
        active.push({ issuer: call.issuer, jti: call.jti });
      }
    }
    return active;
  }
}

class FakeRedisClient {
  readonly published: Array<{
    readonly channel: string;
    readonly message: string;
  }> = [];
  readonly subscribedChannels: string[] = [];
  private messageHandler?: (channel: string, message: string) => void;
  private errorHandler?: (error: unknown) => void;
  subscribeGate?: Promise<void>;
  publishError?: Error;
  subscribeError?: Error;

  async publish(channel: string, message: string): Promise<number> {
    if (this.publishError) throw this.publishError;
    this.published.push({ channel, message });
    return 1;
  }

  async subscribe(channel: string): Promise<string> {
    if (this.subscribeGate) await this.subscribeGate;
    if (this.subscribeError) throw this.subscribeError;
    this.subscribedChannels.push(channel);
    return 'OK';
  }

  async unsubscribe(channel: string): Promise<string> {
    const idx = this.subscribedChannels.indexOf(channel);
    if (idx !== -1) this.subscribedChannels.splice(idx, 1);
    return 'OK';
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (event === 'message') {
      this.messageHandler = (channel, message) => handler(channel, message);
    }
    if (event === 'error') {
      this.errorHandler = (error) => handler(error);
    }
  }

  emitMessage(channel: string, message: string): void {
    this.messageHandler?.(channel, message);
  }

  emitError(error: unknown): void {
    this.errorHandler?.(error);
  }
}

describe('BloomFilterUserAccessTokenRevocationAdapter', () => {
  let underlying: RecordingRevocationAdapter;
  let bloomFilter: InProcessBloomFilter;
  let mockPublisher: FakeRedisClient;
  let mockSubscriber: FakeRedisClient;
  let adapter: BloomFilterUserAccessTokenRevocationAdapter;

  beforeEach(async () => {
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
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('checks the authoritative store for a token missing from a seeded filter', async () => {
    const isRevoked = await adapter.isRevoked({
      issuer: 'aihub_test',
      jti: 'valid_active_jti_123',
      now: new Date(),
    });

    expect(isRevoked).toBe(false);
    expect(underlying.isRevokedCalls).toHaveLength(1);
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

  it('rejects a committed revocation on a healthy peer when its broadcast is lost', async () => {
    const peerSubscriber = new FakeRedisClient();
    const peer = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying,
      bloomFilter: new InProcessBloomFilter(),
      redisSubscriber: peerSubscriber,
    });
    await peer.init();
    expect(peer.isSubscribed).toBe(true);

    mockPublisher.publishError = new Error('Redis connection lost');

    const input = {
      issuer: 'aihub_test',
      jti: 'revoked_offline_jti',
      effectiveExpiresAt: new Date(Date.now() + 3600_000),
    };

    await expect(adapter.revoke(input)).resolves.toBeUndefined();
    expect(underlying.revokeCalls).toEqual([input]);

    expect(
      await peer.isRevoked({
        issuer: input.issuer,
        jti: input.jti,
        now: new Date(),
      }),
    ).toBe(true);
    expect(underlying.isRevokedCalls).toHaveLength(1);
    await peer.close();
  });

  it('rejects a revocation committed after the startup snapshot but before subscription is ready', async () => {
    const snapshotStore = new RecordingRevocationAdapter();
    let finishSnapshot: (
      records: readonly { readonly issuer: string; readonly jti: string }[],
    ) => void = () => undefined;
    const snapshot = new Promise<
      readonly { readonly issuer: string; readonly jti: string }[]
    >((resolve) => {
      finishSnapshot = resolve;
    });
    const listSnapshot = jest.fn(() => snapshot);
    snapshotStore.listActiveRevocations = listSnapshot;
    const subscriber = new FakeRedisClient();
    let finishSubscription: () => void = () => undefined;
    subscriber.subscribeGate = new Promise<void>((resolve) => {
      finishSubscription = resolve;
    });
    const startingFilter = new InProcessBloomFilter();
    const startingInstance = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying: snapshotStore,
      bloomFilter: startingFilter,
      redisSubscriber: subscriber,
    });
    const initialization = startingInstance.init();
    expect(listSnapshot).toHaveBeenCalledTimes(1);
    const token = {
      issuer: 'aihub_test',
      jti: 'committed_during_startup',
      effectiveExpiresAt: new Date(Date.now() + 3600_000),
    };

    await snapshotStore.revoke(token);
    expect(startingInstance.isSubscribed).toBe(false);
    finishSnapshot([]);
    finishSubscription();
    await initialization;

    expect(startingInstance.isSeeded).toBe(true);
    expect(startingInstance.isSubscribed).toBe(true);
    expect(startingFilter.has(JSON.stringify([token.issuer, token.jti]))).toBe(
      false,
    );
    expect(
      await startingInstance.isRevoked({
        issuer: token.issuer,
        jti: token.jti,
        now: new Date(),
      }),
    ).toBe(true);
    expect(snapshotStore.isRevokedCalls).toHaveLength(1);
    await startingInstance.close();
  });

  it('checks the authoritative store when a subscriber loses its connection', async () => {
    const peerSubscriber = new FakeRedisClient();
    const peer = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying,
      bloomFilter: new InProcessBloomFilter(),
      redisSubscriber: peerSubscriber,
    });
    await peer.init();
    peerSubscriber.emitError(new Error('Redis connection gap'));
    expect(peer.isSubscribed).toBe(false);

    const token = {
      issuer: 'aihub_test',
      jti: 'missed_during_connection_gap',
      effectiveExpiresAt: new Date(Date.now() + 3600_000),
    };
    await adapter.revoke(token);

    expect(
      await peer.isRevoked({
        issuer: token.issuer,
        jti: token.jti,
        now: new Date(),
      }),
    ).toBe(true);
    expect(underlying.isRevokedCalls).toHaveLength(1);
    await peer.close();
  });

  it('logs bounded synchronization diagnostics without error details', async () => {
    const unsafeDetail = 'Bearer ey.header.payload.signature';
    const logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const failedStore = new RecordingRevocationAdapter();
    failedStore.listActiveRevocations = jest
      .fn()
      .mockRejectedValue(new Error(unsafeDetail));
    const subscriber = new FakeRedisClient();
    subscriber.subscribeError = new Error(unsafeDetail);
    const publisher = new FakeRedisClient();
    const diagnosticAdapter = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying: failedStore,
      redisPublisher: publisher,
      redisSubscriber: subscriber,
    });

    try {
      await diagnosticAdapter.init();
      subscriber.emitError(new Error(unsafeDetail));
      publisher.publishError = new Error(unsafeDetail);
      await diagnosticAdapter.revoke({
        issuer: 'aihub_test',
        jti: 'diagnostic_test',
        effectiveExpiresAt: new Date(Date.now() + 3600_000),
      });

      expect(logError.mock.calls).toEqual(
        expect.arrayContaining([
          ['Failed to seed token revocations from underlying store'],
          ['Failed to subscribe to token revocation channel'],
          ['Token revocation Redis subscriber connection error'],
          ['Failed to broadcast token revocation'],
        ]),
      );
      expect(
        logError.mock.calls.every(
          (args) =>
            args.length === 1 &&
            typeof args[0] === 'string' &&
            args[0].length <= 80,
        ),
      ).toBe(true);
      expect(JSON.stringify(logError.mock.calls)).not.toContain(unsafeDetail);
    } finally {
      await diagnosticAdapter.close();
      logError.mockRestore();
    }
  });

  it('seeds the filter from underlying store on boot so tokens revoked before restart are rejected', async () => {
    const token = {
      issuer: 'aihub_test',
      jti: 'token_revoked_before_restart',
      effectiveExpiresAt: new Date(Date.now() + 3600_000),
    };
    await adapter.revoke(token);

    // Simulate process restart: create a new adapter instance with an empty filter
    // over the same authoritative store
    const restartedFilter = new InProcessBloomFilter({
      capacity: 10_000,
      falsePositiveRate: 0.00001,
    });
    const restartedAdapter = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying,
      bloomFilter: restartedFilter,
      redisPublisher: mockPublisher,
      redisSubscriber: mockSubscriber,
    });

    // Before seeding, filter is empty
    expect(restartedFilter.has(JSON.stringify([token.issuer, token.jti]))).toBe(
      false,
    );

    // Boot-time seeding
    await restartedAdapter.init();

    // After seeding, the filter contains the key
    expect(restartedFilter.has(JSON.stringify([token.issuer, token.jti]))).toBe(
      true,
    );

    // A token revoked before restart is rejected after restart
    const isRevoked = await restartedAdapter.isRevoked({
      issuer: token.issuer,
      jti: token.jti,
      now: new Date(),
    });
    expect(isRevoked).toBe(true);

    // A token absent from the filter is still checked against the store.
    const callsBefore = underlying.isRevokedCalls.length;
    const unrevoked = await restartedAdapter.isRevoked({
      issuer: 'aihub_test',
      jti: 'unrevoked_clean_token',
      now: new Date(),
    });
    expect(unrevoked).toBe(false);
    expect(underlying.isRevokedCalls.length).toBe(callsBefore + 1);
    await restartedAdapter.close();
  });

  it('observes subscription failure by logging and alerting, falling back to underlying store to avoid failing open', async () => {
    const brokenSubscriber = new FakeRedisClient();
    brokenSubscriber.subscribeError = new Error('Redis connection refused');

    const degradedAdapter = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying,
      bloomFilter: new InProcessBloomFilter(),
      redisPublisher: mockPublisher,
      redisSubscriber: brokenSubscriber,
    });

    await degradedAdapter.init();

    expect(degradedAdapter.isSubscribed).toBe(false);

    // It queries the authoritative store even when subscription failed.
    const callsBefore = underlying.isRevokedCalls.length;
    await degradedAdapter.isRevoked({
      issuer: 'aihub_test',
      jti: 'unknown_token_during_degradation',
      now: new Date(),
    });
    expect(underlying.isRevokedCalls.length).toBe(callsBefore + 1);
    await degradedAdapter.close();
  });

  it('rejects a revoked token immediately on issuing instance and on an instance receiving broadcast', async () => {
    const instanceBFilter = new InProcessBloomFilter({
      capacity: 10_000,
      falsePositiveRate: 0.00001,
    });
    const instanceBSubscriber = new FakeRedisClient();
    const instanceB = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying,
      bloomFilter: instanceBFilter,
      redisSubscriber: instanceBSubscriber,
    });
    await instanceB.init();

    const token = {
      issuer: 'aihub_test',
      jti: 'multi_instance_jti',
      effectiveExpiresAt: new Date(Date.now() + 3600_000),
    };

    // 1. Instance A issues revocation
    await adapter.revoke(token);

    // Instance A rejects it immediately
    expect(
      await adapter.isRevoked({
        issuer: token.issuer,
        jti: token.jti,
        now: new Date(),
      }),
    ).toBe(true);

    // 2. Broadcast simulated from Instance A's publish to Instance B's subscriber
    const published =
      mockPublisher.published[mockPublisher.published.length - 1];
    expect(published).toBeDefined();
    if (published !== undefined) {
      instanceBSubscriber.emitMessage(published.channel, published.message);
    }

    // 3. Instance B rejects it upon receiving broadcast
    expect(
      await instanceB.isRevoked({
        issuer: token.issuer,
        jti: token.jti,
        now: new Date(),
      }),
    ).toBe(true);
    expect(instanceBFilter.has(JSON.stringify([token.issuer, token.jti]))).toBe(
      true,
    );
    await instanceB.close();
  });

  it('falls back to underlying store if seeding fails at boot to avoid failing open', async () => {
    const brokenStore = new RecordingRevocationAdapter();
    brokenStore.listActiveRevocations = jest
      .fn()
      .mockRejectedValue(new Error('DB connection refused'));

    const degradedAdapter = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying: brokenStore,
      bloomFilter: new InProcessBloomFilter(),
    });

    await degradedAdapter.init();

    expect(degradedAdapter.isSeeded).toBe(false);

    // The miss must be checked against the authoritative store.
    await degradedAdapter.isRevoked({
      issuer: 'aihub_test',
      jti: 'token_after_failed_seed',
      now: new Date(),
    });

    expect(brokenStore.isRevokedCalls).toHaveLength(1);
    await degradedAdapter.close();
  });

  it('re-seeds after a failed boot seed without skipping authoritative lookups', async () => {
    const recoveringStore = new RecordingRevocationAdapter();
    let seedAttempts = 0;
    recoveringStore.listActiveRevocations = jest.fn(async () => {
      seedAttempts += 1;
      if (seedAttempts < 2) {
        throw new Error('DB connection refused');
      }
      return [{ issuer: 'aihub_test', jti: 'seeded_on_retry_jti' }];
    });

    const retryAdapter = new BloomFilterUserAccessTokenRevocationAdapter({
      underlying: recoveringStore,
      bloomFilter: new InProcessBloomFilter(),
    });
    await retryAdapter.init();
    expect(retryAdapter.isSeeded).toBe(false);

    // The adapter schedules its own background retry; driving seed() here
    // proves the second attempt re-engages the fast path without a restart.
    await retryAdapter.seed();
    expect(retryAdapter.isSeeded).toBe(true);
    expect(seedAttempts).toBe(2);

    // A successful seed does not make a negative filter result authoritative.
    const callsBefore = recoveringStore.isRevokedCalls.length;
    const unrevoked = await retryAdapter.isRevoked({
      issuer: 'aihub_test',
      jti: 'unrevoked_after_recovery',
      now: new Date(),
    });
    expect(unrevoked).toBe(false);
    expect(recoveringStore.isRevokedCalls.length).toBe(callsBefore + 1);
    await retryAdapter.close();
  });
});
