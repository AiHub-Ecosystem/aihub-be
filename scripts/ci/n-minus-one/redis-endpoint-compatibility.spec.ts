import {
  redisCutoverDecision,
  requireSharedRedisEndpoints,
} from './redis-endpoint-compatibility';

const shared = {
  url: 'redis://cache.internal:6379/0',
  sandbox_url: 'redis://cache.internal:6379/0',
  email_send_rate_url: 'redis://cache.internal:6379/2',
};

describe('redisCutoverDecision', () => {
  it('accepts credential rotation on the same Redis endpoint', () => {
    expect(
      redisCutoverDecision(
        'redis://previous:old@cache.internal:6379/0',
        'redis://candidate:new@cache.internal/0',
      ),
    ).toEqual({ kind: 'shared', identity: 'redis://cache.internal:6379/0' });
  });

  it('requires a held and drained cutover when a release changes database', () => {
    expect(
      redisCutoverDecision(
        'redis://cache.internal:6379/0',
        'redis://cache.internal:6379/1',
      ),
    ).toMatchObject({ kind: 'hold-drain' });
  });

  it('holds the image-pair gate on an incompatible Redis fixture and names both revisions', () => {
    expect(() =>
      requireSharedRedisEndpoints(
        { ...shared, url: 'redis://cache.internal:6379/1' },
        shared,
        'a'.repeat(40),
        'b'.repeat(40),
      ),
    ).toThrow(
      `RELEASE HOLD: N-1 ${'a'.repeat(40)} and N ${'b'.repeat(40)}; url: Redis endpoint changed from redis://cache.internal:6379/1 to redis://cache.internal:6379/0`,
    );
  });

  it('also holds when the Sandbox Redis channel changes', () => {
    expect(() =>
      requireSharedRedisEndpoints(
        shared,
        {
          ...shared,
          sandbox_url: 'redis://cache.internal:6379/3',
        },
        'a'.repeat(40),
        'b'.repeat(40),
      ),
    ).toThrow(/; sandbox_url: Redis endpoint changed/u);
  });

  it('refuses malformed Redis endpoints instead of assuming they are shared', () => {
    expect(() =>
      redisCutoverDecision(
        'redis://cache.internal/0',
        'https://cache.internal',
      ),
    ).toThrow('Redis URL must use redis or rediss');
  });
});
