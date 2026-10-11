import { INCREMENT_WITH_EXPIRY_SCRIPT } from '@/common/redis/increment-with-expiry';
import {
  type RedisRateLimitClient,
  RedisRateLimiter,
} from './redis-rate-limiter';

class FakeRedis implements RedisRateLimitClient {
  readonly values = new Map<string, number>();
  readonly expirations = new Map<string, number>();
  failTtlSetup = false;

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    if (script !== INCREMENT_WITH_EXPIRY_SCRIPT || numberOfKeys !== 1) {
      throw new Error('unexpected Redis script');
    }
    const key = String(args[0]);
    const ttlSeconds = Number(args[1]);
    if (!this.expirations.has(key)) {
      if (this.failTtlSetup) {
        throw new Error('Redis could not set the counter TTL');
      }
      this.values.set(key, this.values.get(key) ?? 0);
      this.expirations.set(key, ttlSeconds);
    }
    const next = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return next;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

class FailingRedis implements RedisRateLimitClient {
  eval(): Promise<number> {
    return Promise.reject(new Error('redis down'));
  }

  quit(): Promise<'OK'> {
    return Promise.resolve('OK');
  }
}

class FakeLogger {
  readonly warnings: string[] = [];
  readonly logs: string[] = [];

  warn(message: string): void {
    this.warnings.push(message);
  }

  log(message: string): void {
    this.logs.push(message);
  }
}

describe('RedisRateLimiter', () => {
  it('uses a namespaced fixed-minute bucket with a two-minute TTL', async () => {
    const redis = new FakeRedis();
    const limiter = new RedisRateLimiter('', redis, () => 61_234);

    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toEqual({ allowed: false, retryAfterMs: 58_766 });

    expect(redis.expirations.get('aihub:v1:rl:ak_backend:1')).toBe(120);
  });

  it.each(['new', 'legacy'])(
    'does not increment a %s bucket when setting its TTL fails',
    async (kind) => {
      const redis = new FakeRedis();
      const bucket = 'aihub:v1:rl:ak_backend:1';
      if (kind === 'legacy') {
        redis.values.set(bucket, 4);
      }
      redis.failTtlSetup = true;
      const limiter = new RedisRateLimiter('', redis, () => 61_234);

      await expect(
        limiter.consume({ keyId: 'ak_backend', limit: 10 }),
      ).resolves.toEqual({ allowed: true });

      expect(redis.values.get(bucket)).toBe(kind === 'legacy' ? 4 : undefined);
      expect(redis.expirations.has(bucket)).toBe(false);
    },
  );

  it('allows traffic when Redis is unavailable so authorization remains independent', async () => {
    await expect(
      new RedisRateLimiter('', new FailingRedis()).consume({
        keyId: 'ak_backend',
        limit: 1,
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it('still applies a ceiling in-process once Redis is unavailable', async () => {
    const limiter = new RedisRateLimiter('', new FailingRedis(), () => 61_234);

    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toEqual({ allowed: false, retryAfterMs: 58_766 });
  });

  it('keeps the process-local ceiling separate per API key', async () => {
    const limiter = new RedisRateLimiter('', new FailingRedis(), () => 61_234);

    await limiter.consume({ keyId: 'ak_one', limit: 1 });

    await expect(
      limiter.consume({ keyId: 'ak_two', limit: 1 }),
    ).resolves.toEqual({ allowed: true });
  });

  it('warns once when Redis becomes unreachable, not on every request', async () => {
    const logger = new FakeLogger();
    const limiter = new RedisRateLimiter(
      '',
      new FailingRedis(),
      Date.now,
      logger,
    );

    await limiter.consume({ keyId: 'ak_backend', limit: 10 });
    await limiter.consume({ keyId: 'ak_backend', limit: 10 });
    await limiter.consume({ keyId: 'ak_backend', limit: 10 });

    expect(logger.warnings).toHaveLength(1);
  });

  it('logs recovery once Redis answers again, and can warn again on a later outage', async () => {
    const logger = new FakeLogger();
    const redis = new FakeRedis();
    const failing = new FailingRedis();
    let current: RedisRateLimitClient = failing;
    const limiter = new RedisRateLimiter(
      '',
      {
        eval: (...args) => current.eval(...args),
        quit: () => current.quit(),
      },
      Date.now,
      logger,
    );

    await limiter.consume({ keyId: 'ak_backend', limit: 10 });
    expect(logger.warnings).toHaveLength(1);

    current = redis;
    await limiter.consume({ keyId: 'ak_backend', limit: 10 });
    expect(logger.logs).toHaveLength(1);

    current = failing;
    await limiter.consume({ keyId: 'ak_backend', limit: 10 });
    expect(logger.warnings).toHaveLength(2);
  });
});
