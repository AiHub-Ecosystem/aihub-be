import { randomBytes } from 'node:crypto';

import Redis from 'ioredis';

import { RedisContentRateLimiter } from '@/modules/content-proxy/infrastructure/redis-content-rate-limiter';
import { sandboxTestRedisUrl } from '../shared/database';

function testAddress(): string {
  const suffix = randomBytes(8).toString('hex').replace(/.{4}/g, ':$&');
  return `2001:db8:${suffix}`;
}

it('counts the first request in a Redis window shared by two limiter instances', async () => {
  const redis = new Redis(sandboxTestRedisUrl(), { lazyConnect: true });
  try {
    await redis.connect();
    const first = new RedisContentRateLimiter('', Date.now, redis);
    const second = new RedisContentRateLimiter('', Date.now, redis);
    const address = testAddress();

    for (let request = 0; request < 30; request += 1) {
      const limiter = request % 2 === 0 ? first : second;
      expect(await limiter.consume(address)).toEqual({ allowed: true });
    }

    const refused = await second.consume(address);
    expect(refused.allowed).toBe(false);
    const retryAfterMs = refused.allowed ? 0 : refused.retryAfterMs;
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(60_000);
    await expect(second.consume(testAddress())).resolves.toEqual({
      allowed: true,
    });
  } finally {
    redis.disconnect();
  }
});
