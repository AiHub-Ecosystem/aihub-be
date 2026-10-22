import {
  EMAIL_PROVIDER_OUTAGE_STATE_KEY,
  type EmailSendRateRedisClient,
  RedisEmailSendRateLimiter,
} from './redis-email-send-rate-limiter';

class FakeRedis implements EmailSendRateRedisClient {
  result: unknown = [1, 0];
  results: unknown[] = [];
  failure: Error | undefined;
  readonly calls: unknown[][] = [];

  async eval(
    ...args: [script: string, numberOfKeys: number, ...values: string[]]
  ): Promise<unknown> {
    this.calls.push(args);
    if (this.failure !== undefined) throw this.failure;
    if (this.results.length > 0) return this.results.shift();
    return this.result;
  }

  on(): this {
    return this;
  }

  disconnect(): void {}
}

describe('RedisEmailSendRateLimiter', () => {
  it('reserves one steadily paced account-wide send', async () => {
    const redis = new FakeRedis();
    const limiter = new RedisEmailSendRateLimiter('', 2, 1_000, redis);

    await expect(limiter.reserve()).resolves.toEqual({ reserved: true });
    expect(redis.calls[0]).toMatchObject([
      expect.any(String),
      1,
      expect.stringContaining('resend'),
      '500',
    ]);
  });

  it('returns the wait until the next send slot without a burst', async () => {
    const redis = new FakeRedis();
    redis.result = [0, 125];
    const limiter = new RedisEmailSendRateLimiter('', 2, 1_000, redis);

    await expect(limiter.reserve()).resolves.toEqual({
      reserved: false,
      retryAfterMs: 125,
    });
  });

  it('fails closed when Redis is unavailable', async () => {
    const redis = new FakeRedis();
    redis.failure = new Error('connection refused');
    const limiter = new RedisEmailSendRateLimiter('', 2, 1_000, redis);

    await expect(limiter.reserve()).resolves.toEqual({
      reserved: false,
      retryAfterMs: 5_000,
    });
  });

  it('fails closed when explicit rate configuration is absent or invalid', async () => {
    const redis = new FakeRedis();
    const unconfigured = new RedisEmailSendRateLimiter(
      '',
      undefined,
      1_000,
      redis,
    );
    const invalid = new RedisEmailSendRateLimiter('', 0, 1_000, redis);

    await expect(unconfigured.reserve()).resolves.toEqual({
      reserved: false,
      retryAfterMs: 5_000,
    });
    await expect(invalid.reserve()).resolves.toEqual({
      reserved: false,
      retryAfterMs: 5_000,
    });
    expect(redis.calls).toEqual([]);
  });

  it('uses the shared outage key for a half-open permit', async () => {
    const redis = new FakeRedis();
    redis.results = [
      [1, 0, 'probe-one'],
      [0, 15_000, ''],
    ];
    const limiter = new RedisEmailSendRateLimiter('', 2, 1_000, redis);

    await expect(limiter.acquireSendPermit()).resolves.toEqual({
      allowed: true,
      probeToken: 'probe-one',
    });
    await expect(limiter.acquireSendPermit()).resolves.toEqual({
      allowed: false,
      retryAfterMs: 15_000,
    });

    expect(redis.calls.map((call) => call.slice(1, 3))).toEqual([
      [1, EMAIL_PROVIDER_OUTAGE_STATE_KEY],
      [1, EMAIL_PROVIDER_OUTAGE_STATE_KEY],
    ]);
  });

  it('fails closed when Redis cannot coordinate an outage probe', async () => {
    const redis = new FakeRedis();
    redis.failure = new Error('connection refused');
    const limiter = new RedisEmailSendRateLimiter('', 2, 1_000, redis);

    await expect(limiter.acquireSendPermit()).resolves.toEqual({
      allowed: false,
      retryAfterMs: 5_000,
    });
  });

  it('applies Redis full-jitter backoff while keeping Retry-After as a minimum', async () => {
    const redis = new FakeRedis();
    redis.result = 60_000;
    const limiter = new RedisEmailSendRateLimiter(
      '',
      2,
      1_000,
      redis,
      () => 0.8,
    );

    await expect(limiter.recordProviderFailure(30_000)).resolves.toBe(60_000);

    expect(redis.calls[0]).toMatchObject([
      expect.any(String),
      1,
      EMAIL_PROVIDER_OUTAGE_STATE_KEY,
      '0.8',
      '30000',
      '60000',
      '',
      '360000',
    ]);
  });
});
