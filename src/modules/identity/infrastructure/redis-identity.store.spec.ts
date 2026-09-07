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
  scopes: ['writing.question.generate'],
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

  set(key: string, value: string, _mode: 'EX', seconds: number): Promise<'OK'> {
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
    await expect(failures.get('203.0.113.10')).resolves.toBe(0);
    await expect(failures.recordFailure('203.0.113.10')).resolves.toBe(0);
  });
});
