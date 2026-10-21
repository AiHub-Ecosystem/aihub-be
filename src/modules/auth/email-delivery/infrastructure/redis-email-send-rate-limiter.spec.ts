import {
  type EmailSendRateRedisClient,
  RedisEmailSendRateLimiter,
} from './redis-email-send-rate-limiter';

class FakeRedis implements EmailSendRateRedisClient {
  result: unknown = [1, 0];
  failure: Error | undefined;
  readonly calls: unknown[][] = [];

  async eval(
    ...args: [script: string, numberOfKeys: number, ...values: string[]]
  ): Promise<unknown> {
    this.calls.push(args);
    if (this.failure !== undefined) throw this.failure;
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
});
