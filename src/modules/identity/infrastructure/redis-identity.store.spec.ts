import type { ApiKeyRecord } from '../application/api-key-authenticator.port';
import {
  RedisAuthFailureCounter,
  type RedisIdentityClient,
  RedisIdentityStore,
} from './redis-identity.store';

const record: ApiKeyRecord = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  organizationStatus: 'active',
  status: 'active',
  scopes: ['writing.grade'],
  entitlements: ['writing'],
  allowedEnvironments: ['development'],
  expiresAt: null,
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
};

class FakeRedis implements RedisIdentityClient {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, number>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(
    key: string,
    value: string,
    _mode: 'EX',
    seconds: number,
    condition?: 'NX',
  ): Promise<'OK' | null> {
    if (condition === 'NX' && this.values.has(key)) {
      return Promise.resolve(null);
    }
    this.values.set(key, value);
    this.expirations.set(key, seconds);
    return Promise.resolve('OK');
  }

  del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) {
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  incr(key: string): Promise<number> {
    const next = Number(this.values.get(key) ?? '0') + 1;
    this.values.set(key, String(next));
    return Promise.resolve(next);
  }

  expire(key: string, seconds: number): Promise<number> {
    this.expirations.set(key, seconds);
    return Promise.resolve(1);
  }

  quit(): Promise<'OK'> {
    return Promise.resolve('OK');
  }
}

describe('RedisIdentityStore', () => {
  it('stores and reads a positive API-key cache entry with a 60-second TTL', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdentityStore('', redis);

    await store.set('a'.repeat(64), record);

    await expect(store.get('a'.repeat(64))).resolves.toEqual(record);
    expect(redis.expirations.get(`aihub:v1:key:${'a'.repeat(64)}`)).toBe(60);
  });

  it('stores and reads a negative API-key cache entry with a 30-second TTL', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdentityStore('', redis);

    await store.setMiss('b'.repeat(64));

    await expect(store.get('b'.repeat(64))).resolves.toBeNull();
    expect(redis.expirations.get(`aihub:v1:key:miss:${'b'.repeat(64)}`)).toBe(
      30,
    );
  });

  it('counts failed authentication by IP for five minutes', async () => {
    const redis = new FakeRedis();
    const store = new RedisAuthFailureCounter('', redis);

    await expect(store.recordFailure('203.0.113.10')).resolves.toBe(1);
    await expect(store.recordFailure('203.0.113.10')).resolves.toBe(2);
    await expect(store.get('203.0.113.10')).resolves.toBe(2);
    expect(redis.expirations.get('aihub:v1:authfail:203.0.113.10')).toBe(300);
  });

  it('stores JWKS metadata for the stale-cache window and gates refreshes per organization', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdentityStore('', redis);
    const entry = {
      jwks: {
        keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB', alg: 'RS256' }],
      },
      freshUntil: Date.now() + 15 * 60 * 1_000,
      staleUntil: Date.now() + 24 * 60 * 60 * 1_000,
    };

    await store.setJwks('org_acme', '1', '0', entry);

    await expect(store.getJwks('org_acme', '1')).resolves.toEqual({
      generation: '0',
      entry,
    });
    expect(redis.expirations.get('aihub:v1:jwks:org_acme:1:0')).toBeGreaterThan(
      86_390,
    );
    await expect(store.tryAcquireRefresh('org_acme')).resolves.toEqual({
      acquired: true,
      available: true,
    });
    await expect(store.tryAcquireRefresh('org_acme')).resolves.toEqual({
      acquired: false,
      available: true,
    });
    expect(redis.expirations.get('aihub:v1:jwks-refresh:org_acme')).toBe(300);
  });

  it('confirms JWKS cache deletion for an Organization', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdentityStore('', redis);
    await store.setJwks('org_acme', '2', '0', {
      jwks: { keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB' }] },
      freshUntil: Date.now() + 1_000,
      staleUntil: Date.now() + 2_000,
    });

    await store.deleteJwks('org_acme', '2');

    await expect(store.getJwks('org_acme', '2')).resolves.toEqual({
      generation: '1',
    });
    expect(redis.values.get('aihub:v1:jwks-generation:org_acme')).toBe('1');
  });

  it('fails open for cache and brute-force protection when Redis is unavailable', async () => {
    const redis: RedisIdentityClient = {
      get: () => Promise.reject(new Error('redis down')),
      set: () => Promise.reject(new Error('redis down')),
      del: () => Promise.reject(new Error('redis down')),
      incr: () => Promise.reject(new Error('redis down')),
      expire: () => Promise.reject(new Error('redis down')),
      quit: () => Promise.resolve('OK'),
    };
    const store = new RedisIdentityStore('', redis);
    const failures = new RedisAuthFailureCounter('', redis);

    await expect(store.get('a'.repeat(64))).resolves.toBeUndefined();
    await expect(store.deleteJwks('org_acme', '1')).rejects.toThrow(
      'redis down',
    );
    await expect(failures.get('203.0.113.10')).resolves.toBe(0);
    await expect(failures.recordFailure('203.0.113.10')).resolves.toBe(0);
  });
});
