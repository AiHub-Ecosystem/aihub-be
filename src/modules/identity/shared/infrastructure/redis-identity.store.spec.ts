import { INCREMENT_WITH_EXPIRY_SCRIPT } from '@/common/redis/increment-with-expiry';
import type { ApiKeyRecord } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import {
  RedisAuthFailureCounter,
  type RedisIdentityClient,
  RedisIdentityStore,
} from './redis-identity.store';

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
  readonly expiresAt = new Map<string, number>();
  getCalls = 0;
  failReads = false;
  failTtlSetup = false;

  get(key: string): Promise<string | null> {
    this.getCalls += 1;
    if (this.failReads) {
      return Promise.reject(new Error('redis down'));
    }
    const expiresAt = this.expiresAt.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.values.delete(key);
      this.expiresAt.delete(key);
      return Promise.resolve(null);
    }
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
    this.expiresAt.set(key, Date.now() + seconds * 1_000);
    return Promise.resolve('OK');
  }

  pttl(key: string): Promise<number> {
    const expiresAt = this.expiresAt.get(key);
    if (expiresAt === undefined) {
      return Promise.resolve(this.values.has(key) ? -1 : -2);
    }
    const remaining = expiresAt - Date.now();
    return Promise.resolve(remaining > 0 ? remaining : -2);
  }

  del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) {
        deleted += 1;
      }
      this.expiresAt.delete(key);
    }
    return Promise.resolve(deleted);
  }

  incr(key: string): Promise<number> {
    const next = Number(this.values.get(key) ?? '0') + 1;
    this.values.set(key, String(next));
    return Promise.resolve(next);
  }

  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    if (script !== INCREMENT_WITH_EXPIRY_SCRIPT || numberOfKeys !== 1) {
      return Promise.reject(new Error('unexpected Redis script'));
    }
    const key = String(args[0]);
    const ttlSeconds = Number(args[1]);
    if (!this.expirations.has(key)) {
      if (this.failTtlSetup) {
        return Promise.reject(new Error('Redis could not set the counter TTL'));
      }
      this.values.set(key, this.values.get(key) ?? '0');
      this.expirations.set(key, ttlSeconds);
    }
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
    expect(
      redis.expirations.get(`aihub:v1:key:${'a'.repeat(64)}`),
    ).toBeLessThanOrEqual(60);
    expect(
      redis.expirations.get(`aihub:v1:key:${'a'.repeat(64)}`),
    ).toBeGreaterThanOrEqual(30);
  });

  it('stores and reads a positive API-key cache entry with an expiry date', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdentityStore('', redis);
    const dated = {
      ...record,
      expiresAt: new Date('2026-10-01T00:00:00.000Z'),
    };

    await store.set('c'.repeat(64), dated);

    await expect(store.get('c'.repeat(64))).resolves.toEqual(dated);
  });

  it('treats a cached entry with a malformed field as a cache miss', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdentityStore('', redis);
    redis.values.set(
      `aihub:v1:key:${'d'.repeat(64)}`,
      JSON.stringify({ ...record, monthlyRequestQuota: 'nope' }),
    );

    await expect(store.get('d'.repeat(64))).resolves.toBeUndefined();
    expect(redis.values.has(`aihub:v1:key:${'d'.repeat(64)}`)).toBe(false);
  });

  it('stores and reads a negative API-key cache entry with a jittered TTL capped at 30 seconds', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdentityStore('', redis);

    await store.setMiss('b'.repeat(64));

    await expect(store.get('b'.repeat(64))).resolves.toBeNull();
    expect(
      redis.expirations.get(`aihub:v1:key:miss:${'b'.repeat(64)}`),
    ).toBeLessThanOrEqual(30);
    expect(
      redis.expirations.get(`aihub:v1:key:miss:${'b'.repeat(64)}`),
    ).toBeGreaterThanOrEqual(15);
  });

  it('serves API-key entries from a non-sliding local lease before Redis', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const redis = new FakeRedis();
    const store = new RedisIdentityStore('', redis);
    const hash = 'f'.repeat(64);

    await store.set(hash, record);
    expect(redis.expirations.get(`aihub:v1:key:${hash}`)).toBe(30);
    await expect(store.get(hash)).resolves.toEqual(record);
    jest.advanceTimersByTime(20_000);
    await expect(store.get(hash)).resolves.toEqual(record);
    expect(redis.getCalls).toBe(0);

    jest.advanceTimersByTime(10_001);
    await expect(store.get(hash)).resolves.toBeUndefined();
    expect(redis.getCalls).toBeGreaterThan(0);
  });

  it('uses a valid local API-key entry when Redis becomes unavailable', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdentityStore('', redis);
    const hash = 'e'.repeat(64);
    await store.set(hash, record);
    redis.failReads = true;

    await expect(store.get(hash)).resolves.toEqual(record);
    expect(redis.getCalls).toBe(0);
  });

  it('purges a key from the local tier and Redis on deletion', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdentityStore('', redis);
    const hash = 'c'.repeat(64);
    await store.set(hash, record);
    await expect(store.get(hash)).resolves.toEqual(record);
    expect(redis.getCalls).toBe(0);

    await store.delete(hash);

    expect(redis.values.has(`aihub:v1:key:${hash}`)).toBe(false);
    await expect(store.get(hash)).resolves.toBeUndefined();
    expect(redis.getCalls).toBe(2);
  });

  it('counts failed authentication by IP for five minutes', async () => {
    const redis = new FakeRedis();
    const store = new RedisAuthFailureCounter('', redis);

    await expect(store.recordFailure('203.0.113.10')).resolves.toBe(1);
    await expect(store.recordFailure('203.0.113.10')).resolves.toBe(2);
    await expect(store.get('203.0.113.10')).resolves.toBe(2);
    expect(redis.expirations.get('aihub:v1:authfail:203.0.113.10')).toBe(300);
  });

  it.each(['new', 'legacy'])(
    'does not increment a %s auth-failure counter when setting its TTL fails',
    async (kind) => {
      const redis = new FakeRedis();
      const key = 'aihub:v1:authfail:203.0.113.10';
      if (kind === 'legacy') {
        redis.values.set(key, '4');
      }
      redis.failTtlSetup = true;
      const logger = new FakeLogger();
      const counter = new RedisAuthFailureCounter('', redis, logger);

      await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(0);

      expect(redis.values.get(key)).toBe(kind === 'legacy' ? '4' : undefined);
      expect(redis.expirations.has(key)).toBe(false);
      expect(logger.warnings).toHaveLength(1);
      expect(logger.warnings[0]).not.toContain('203.0.113.10');

      await counter.recordFailure('203.0.113.10');
      expect(logger.warnings).toHaveLength(1);

      redis.failTtlSetup = false;
      await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(
        kind === 'legacy' ? 5 : 1,
      );
      expect(redis.expirations.get(key)).toBe(300);
      expect(logger.logs).toHaveLength(1);
    },
  );

  it('keeps a failed counter write degraded across successful reads', async () => {
    const redis = new FakeRedis();
    redis.failTtlSetup = true;
    const logger = new FakeLogger();
    const counter = new RedisAuthFailureCounter('', redis, logger);

    await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(0);
    await expect(counter.get('203.0.113.10')).resolves.toBe(0);
    await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(0);

    expect(logger.warnings).toHaveLength(1);
    expect(logger.logs).toHaveLength(0);

    redis.failTtlSetup = false;
    await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(1);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.logs).toHaveLength(1);
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

  it('uses the last-good JWKS locally when Redis is unavailable, bound to config version', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdentityStore('', redis);
    const entry = {
      jwks: { keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB' }] },
      freshUntil: Date.now() + 1_000,
      staleUntil: Date.now() + 60_000,
    };
    await store.setJwks('org_local', '7', '0', entry);
    redis.failReads = true;

    await expect(store.getJwks('org_local', '7')).resolves.toEqual({
      generation: '0',
      entry,
    });
    await expect(store.getJwks('org_local', '8')).resolves.toEqual({
      generation: '0',
    });
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
      pttl: () => Promise.reject(new Error('redis down')),
      set: () => Promise.reject(new Error('redis down')),
      del: () => Promise.reject(new Error('redis down')),
      incr: () => Promise.reject(new Error('redis down')),
      eval: () => Promise.reject(new Error('redis down')),
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
