import {
  type RedisRateLimitClient,
  RedisRateLimiter,
} from './redis-rate-limiter';

class FakeRedis implements RedisRateLimitClient {
  readonly values = new Map<string, number>();
  readonly expirations = new Map<string, number>();

  async incr(key: string): Promise<number> {
    const next = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expirations.set(key, seconds);
    return 1;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
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

  it('allows traffic when Redis is unavailable so authorization remains independent', async () => {
    const redis: RedisRateLimitClient = {
      incr: () => Promise.reject(new Error('redis down')),
      expire: () => Promise.reject(new Error('redis down')),
      quit: () => Promise.resolve('OK'),
    };

    await expect(
      new RedisRateLimiter('', redis).consume({
        keyId: 'ak_backend',
        limit: 1,
      }),
    ).resolves.toEqual({ allowed: true });
  });
});
