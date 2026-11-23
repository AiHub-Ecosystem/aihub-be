import { getMetrics } from '@/common/observability/metrics';
import { INCREMENT_WITH_EXPIRY_SCRIPT } from '@/common/redis/increment-with-expiry';
import {
  AUTH_FAILURE_LIMIT,
  ApiKeyAuthenticator,
} from '@/modules/identity/api-keys/application/api-key-authenticator';
import {
  API_KEY_LOOKUP_BUDGET_BURST,
  API_KEY_LOOKUP_FALLBACK_BURST,
  API_KEY_LOOKUP_FALLBACK_PER_SECOND,
  type ApiKeyRecord,
  apiKeyCacheKey,
  apiKeyCacheMissKey,
  apiKeyLookupBudgetKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import {
  generateOrganizationApiKey,
  hashApiKey,
} from '@/modules/identity/api-keys/application/organization-api-key-generator';
import {
  signIdentityCacheEntry,
  verifyIdentityCacheEntry,
} from './identity-cache-envelope';
import {
  API_KEY_LOOKUP_BUDGET_SCRIPT,
  RedisAuthFailureCounter,
} from './redis-auth-failure-counter';
import type { RedisIdentityClient } from './redis-identity-client';
import { RedisIdentityStore } from './redis-identity.store';

class FakeLogger {
  readonly warnings: Record<string, unknown>[] = [];
  readonly logs: Record<string, unknown>[] = [];

  warn(event: Record<string, unknown>): void {
    this.warnings.push(event);
  }

  log(event: Record<string, unknown>): void {
    this.logs.push(event);
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

const TEST_HMAC_KEY = Buffer.alloc(32, 7);

function createStore(redis: RedisIdentityClient, hmacKey?: Buffer) {
  return new RedisIdentityStore(
    '',
    redis,
    hmacKey === undefined ? TEST_HMAC_KEY : hmacKey,
  );
}

function createKeylessStore(redis: RedisIdentityClient) {
  return new RedisIdentityStore('', redis, undefined);
}

/** Every command fails, as a refused or dead Redis answers. */
const DEAD_REDIS: RedisIdentityClient = {
  get: () => Promise.reject(new Error('redis down')),
  pttl: () => Promise.reject(new Error('redis down')),
  set: () => Promise.reject(new Error('redis down')),
  del: () => Promise.reject(new Error('redis down')),
  incr: () => Promise.reject(new Error('redis down')),
  eval: () => Promise.reject(new Error('redis down')),
  expire: () => Promise.reject(new Error('redis down')),
  quit: () => Promise.resolve('OK'),
};

async function redisUnavailableCount(seam: string): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith(`aihub_redis_unavailable_total{seam="${seam}"} `),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

async function integrityRejectionCount(cacheKind: 'api_key' | 'jwks') {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith(
        `aihub_identity_cache_integrity_rejections_total{cache_kind="${cacheKind}"} `,
      ),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

class FakeRedis implements RedisIdentityClient {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, number>();
  readonly expiresAt = new Map<string, number>();
  getCalls = 0;
  clock = Date.now();
  failReads = false;
  failWrites = false;
  failDeletes = false;
  failTtlSetup = false;
  failLookupBudget = false;
  readonly lookupBuckets = new Map<
    string,
    { tokens: number; updatedAt: number }
  >();

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
    if (this.failWrites) {
      return Promise.reject(new Error('redis down'));
    }
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
    if (this.failDeletes) {
      return Promise.reject(new Error('redis down'));
    }
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
    if (script === API_KEY_LOOKUP_BUDGET_SCRIPT && numberOfKeys === 1) {
      if (this.failLookupBudget) {
        return Promise.reject(new Error('lookup budget unavailable'));
      }
      const key = String(args[0]);
      const capacity = Number(args[1]);
      const refillPerMs = Number(args[2]);
      const previous = this.lookupBuckets.get(key) ?? {
        tokens: capacity,
        updatedAt: this.clock,
      };
      previous.tokens = Math.min(
        capacity,
        previous.tokens +
          Math.max(0, this.clock - previous.updatedAt) * refillPerMs,
      );
      previous.updatedAt = Math.max(this.clock, previous.updatedAt);
      if (previous.tokens >= 1) {
        previous.tokens -= 1;
        this.lookupBuckets.set(key, previous);
        this.expirations.set(key, 120);
        return Promise.resolve(1);
      }
      this.lookupBuckets.set(key, previous);
      this.expirations.set(key, 120);
      return Promise.resolve(-Math.ceil((1 - previous.tokens) / refillPerMs));
    }
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
  it('reserves assertion replay markers once per Organization and environment', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    const input = {
      organizationId: 'org_acme',
      environment: 'production' as const,
      jti: 'shared-jti',
      ttlSeconds: 160,
    };

    await expect(store.reserve(input)).resolves.toBe(true);
    await expect(store.reserve(input)).resolves.toBe(false);
    await expect(
      store.reserve({ ...input, environment: 'sandbox' }),
    ).resolves.toBe(true);
    await expect(
      store.reserve({ ...input, organizationId: 'org_other' }),
    ).resolves.toBe(true);
    expect(
      redis.expirations.get(
        'aihub:v1:user-assertion-replay:org_acme:production:shared-jti',
      ),
    ).toBe(160);
  });

  it('stores and reads a positive API-key cache entry with a 60-second TTL', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);

    await store.set('a'.repeat(64), record);

    await expect(store.get('a'.repeat(64))).resolves.toEqual(record);
    expect(
      redis.expirations.get(`aihub:v1:key:${'a'.repeat(64)}`),
    ).toBeLessThanOrEqual(60);
    expect(
      redis.expirations.get(`aihub:v1:key:${'a'.repeat(64)}`),
    ).toBeGreaterThanOrEqual(30);
  });

  it('keeps a positive entry within its captured freshness deadline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    try {
      const redis = new FakeRedis();
      const store = createStore(redis);
      const hash = 'a'.repeat(64);
      const freshUntil = Date.now() + 5_500;

      await store.set(hash, record, freshUntil);
      expect(redis.expirations.get(apiKeyCacheKey(hash))).toBe(6);

      jest.advanceTimersByTime(5_501);
      await expect(store.get(hash)).resolves.toBeUndefined();
      expect(redis.values.has(apiKeyCacheKey(hash))).toBe(false);
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });

  it('authenticates from the repository when a forged API-key cache entry is read', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    const apiKey = generateOrganizationApiKey().raw;
    const hash = hashApiKey(apiKey);
    const cacheKey = apiKeyCacheKey(hash);
    redis.values.set(
      cacheKey,
      signIdentityCacheEntry(Buffer.alloc(32, 8), 'api_key', cacheKey, {
        type: 'record',
        freshUntil: Date.now() + 60_000,
        record: { ...record, organizationId: 'org_forged' },
      }),
    );
    const repository = {
      findByHash: jest.fn().mockResolvedValue(record),
      touchLastUsed: jest.fn().mockResolvedValue(undefined),
    };
    const authenticator = new ApiKeyAuthenticator(repository, store, {
      get: async () => 0,
      recordFailure: async () => 1,
      consumeSandboxKeyLookup: async () => true,
      consumeUncachedLookup: async () => ({
        allowed: true,
      }),
    });

    await expect(
      authenticator.authenticate({
        value: apiKey,
        environment: 'development',
        clientIp: '198.51.100.7',
      }),
    ).resolves.toMatchObject({
      organizationId: record.organizationId,
      scopes: record.scopes,
    });

    expect(repository.findByHash).toHaveBeenCalledWith(hash);
    expect(redis.values.get(cacheKey)).not.toContain('org_forged');
  });

  it.each(['set', 'delete'] as const)(
    'counts a failed API-key cache %s once without throwing',
    async (operation) => {
      const before = await redisUnavailableCount('api_key_cache');
      const redis = new FakeRedis();
      const store = createStore(redis);
      let operationResult: Promise<void>;
      if (operation === 'set') {
        redis.failWrites = true;
        operationResult = store.set('a'.repeat(64), record);
      } else {
        redis.failDeletes = true;
        operationResult = store.delete('a'.repeat(64));
      }

      await expect(operationResult).resolves.toBeUndefined();
      expect(await redisUnavailableCount('api_key_cache')).toBe(before + 1);
    },
  );

  it('does not count successful API-key cache commands as unavailable', async () => {
    const before = await redisUnavailableCount('api_key_cache');
    const redis = new FakeRedis();
    const store = createStore(redis);

    await store.set('a'.repeat(64), record);
    await store.setMiss('b'.repeat(64));
    await store.delete('a'.repeat(64));

    expect(await redisUnavailableCount('api_key_cache')).toBe(before);
  });

  it('uses the action-specific seam when an API-key invalidation fails', async () => {
    const seam = 'api_key_cache_invalidation_revoke';
    const before = await redisUnavailableCount(seam);
    const genericBefore = await redisUnavailableCount('api_key_cache');
    const redis = new FakeRedis();
    redis.failDeletes = true;
    const store = createStore(redis);

    await expect(store.delete('a'.repeat(64), seam)).resolves.toBeUndefined();

    expect(await redisUnavailableCount(seam)).toBe(before + 1);
    expect(await redisUnavailableCount('api_key_cache')).toBe(genericBefore);
  });

  it('stores and reads a positive API-key cache entry with an expiry date', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    const dated = {
      ...record,
      expiresAt: new Date('2026-10-01T00:00:00.000Z'),
    };

    await store.set('c'.repeat(64), dated);

    await expect(store.get('c'.repeat(64))).resolves.toEqual(dated);
  });

  it('treats a cached entry with a malformed field as a cache miss', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    redis.values.set(
      `aihub:v1:key:${'d'.repeat(64)}`,
      JSON.stringify({ ...record, monthlyRequestQuota: 'nope' }),
    );

    await expect(store.get('d'.repeat(64))).resolves.toBeUndefined();
    expect(redis.values.has(`aihub:v1:key:${'d'.repeat(64)}`)).toBe(false);
  });

  it('keeps negative API-key cache entries in bounded local memory only', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    const hash = 'b'.repeat(64);

    jest.useFakeTimers().setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await store.setMiss(hash);

      await expect(store.get(hash)).resolves.toBeNull();
      expect(redis.values.has(apiKeyCacheMissKey(hash))).toBe(false);
      expect(redis.expirations.has(apiKeyCacheMissKey(hash))).toBe(false);
      expect(redis.getCalls).toBe(0);

      jest.advanceTimersByTime(15_001);
      await expect(store.get(hash)).resolves.toBeUndefined();
      expect(redis.getCalls).toBe(2);
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });

  it('evicts negative API-key entries at the local cache ceiling', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    const oldestHash = 'a'.repeat(64);

    await store.setMiss(oldestHash);
    for (let entry = 0; entry < 1_024; entry += 1) {
      await store.setMiss(String(entry).padStart(64, '0'));
    }

    await expect(store.get(oldestHash)).resolves.toBeUndefined();
    expect(redis.getCalls).toBe(2);
    expect(
      [...redis.values.keys()].filter((key) => key.includes(':miss:')),
    ).toHaveLength(0);
  });

  it('serves API-key entries from a non-sliding local lease before Redis', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const redis = new FakeRedis();
    const store = createStore(redis);
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
    const store = createStore(redis);
    const hash = 'e'.repeat(64);
    await store.set(hash, record);
    redis.failReads = true;

    await expect(store.get(hash)).resolves.toEqual(record);
    expect(redis.getCalls).toBe(0);
  });

  it('purges a key from the local tier and Redis on deletion', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
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

  it('caps Sandbox authentication lookups per key for one minute', async () => {
    const redis = new FakeRedis();
    const counter = new RedisAuthFailureCounter('', redis);
    const hash = 'a'.repeat(64);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(counter.consumeSandboxKeyLookup(hash)).resolves.toBe(true);
    }
    await expect(counter.consumeSandboxKeyLookup(hash)).resolves.toBe(false);
    expect(redis.expirations.get(`aihub:v1:sandbox-key-auth:${hash}`)).toBe(60);
  });

  it('keeps Sandbox authentication available when Redis cannot set the lookup limit', async () => {
    const redis = new FakeRedis();
    redis.failTtlSetup = true;
    const logger = new FakeLogger();
    const counter = new RedisAuthFailureCounter('', redis, logger);

    await expect(counter.consumeSandboxKeyLookup('a'.repeat(64))).resolves.toBe(
      true,
    );
    expect(logger.warnings).toHaveLength(1);
  });

  it.each(['new', 'legacy'])(
    'keeps a %s auth-failure counter local when setting its TTL fails',
    async (kind) => {
      const redis = new FakeRedis();
      const key = 'aihub:v1:authfail:203.0.113.10';
      if (kind === 'legacy') {
        redis.values.set(key, '4');
      }
      redis.failTtlSetup = true;
      const logger = new FakeLogger();
      const counter = new RedisAuthFailureCounter('', redis, logger);

      // Redis must not hold an untimed counter, but the outage cannot lift the
      // per-address bound, so the count lives in this process instead (#1511).
      await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(1);

      expect(redis.values.get(key)).toBe(kind === 'legacy' ? '4' : undefined);
      expect(redis.expirations.has(key)).toBe(false);
      expect(logger.warnings).toHaveLength(1);
      expect(JSON.stringify(logger.warnings[0])).not.toContain('203.0.113.10');

      await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(2);
      expect(logger.warnings).toHaveLength(1);

      redis.failTtlSetup = false;
      // The local count is a floor, so the shared counter never reads lower.
      await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(
        kind === 'legacy' ? 5 : 3,
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

    await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(1);
    await expect(counter.get('203.0.113.10')).resolves.toBe(1);
    await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(2);

    expect(logger.warnings).toHaveLength(1);
    expect(logger.logs).toHaveLength(0);

    redis.failTtlSetup = false;
    await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(3);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.logs).toHaveLength(1);
  });

  it('shares a token bucket across counter instances and refills at the configured rate', async () => {
    const redis = new FakeRedis();
    redis.clock = 1_000_000;
    const counter = new RedisAuthFailureCounter('', redis);
    const otherCounter = new RedisAuthFailureCounter('', redis);

    for (
      let attempt = 1;
      attempt <= API_KEY_LOOKUP_BUDGET_BURST;
      attempt += 1
    ) {
      await expect(counter.consumeUncachedLookup()).resolves.toEqual({
        allowed: true,
      });
    }

    await expect(otherCounter.consumeUncachedLookup()).resolves.toEqual({
      allowed: false,
      retryAfterMs: 10,
    });
    redis.clock += 10;
    await expect(otherCounter.consumeUncachedLookup()).resolves.toEqual({
      allowed: true,
    });
    expect(redis.expirations.get(apiKeyLookupBudgetKey())).toBe(120);
  });

  it('uses a stricter burst and refill limit in the process-local fallback', async () => {
    const redis = new FakeRedis();
    redis.failLookupBudget = true;
    let now = 1_000_000;
    const counter = new RedisAuthFailureCounter(
      '',
      redis,
      undefined,
      () => now,
    );

    for (
      let attempt = 1;
      attempt <= API_KEY_LOOKUP_FALLBACK_BURST;
      attempt += 1
    ) {
      await counter.consumeUncachedLookup();
    }

    const refillMs = Math.ceil(1_000 / API_KEY_LOOKUP_FALLBACK_PER_SECOND);
    await expect(counter.consumeUncachedLookup()).resolves.toEqual({
      allowed: false,
      retryAfterMs: refillMs,
    });

    now += refillMs;
    await expect(counter.consumeUncachedLookup()).resolves.toEqual({
      allowed: true,
    });
  });

  it('reports missing Redis without exposing request identifiers', async () => {
    const logger = new FakeLogger();
    const counter = new RedisAuthFailureCounter('', undefined, logger);
    const before = await redisUnavailableCount('auth_failure_counter');

    await expect(counter.consumeUncachedLookup()).resolves.toEqual({
      allowed: true,
    });
    await counter.get('203.0.113.10');

    expect(logger.warnings).toHaveLength(1);
    expect(JSON.stringify(logger.warnings)).not.toContain('203.0.113.10');
    expect(await redisUnavailableCount('auth_failure_counter')).toBeGreaterThan(
      before,
    );
  });

  it('keeps counting an over-threshold address when every Redis command fails', async () => {
    const counter = new RedisAuthFailureCounter('', DEAD_REDIS);

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      await expect(counter.recordFailure('203.0.113.10')).resolves.toBe(
        attempt,
      );
    }

    await expect(counter.get('203.0.113.10')).resolves.toBe(20);
    await expect(counter.consumeUncachedLookup()).resolves.toEqual({
      allowed: true,
    });
  });

  it('refuses an over-threshold local IP before Postgres during a Redis outage', async () => {
    const counter = new RedisAuthFailureCounter('', DEAD_REDIS);
    const repository = {
      findByHash: jest.fn(async () => null),
      touchLastUsed: async () => undefined,
    };
    const cache = {
      get: async () => undefined,
      newPositiveFreshUntil: () => Date.now() + 60_000,
      set: async () => undefined,
      setMiss: async () => undefined,
      delete: async () => undefined,
    };
    const authenticator = new ApiKeyAuthenticator(repository, cache, counter);
    const clientIp = '203.0.113.10';
    for (let attempt = 0; attempt < AUTH_FAILURE_LIMIT; attempt += 1) {
      await counter.recordFailure(clientIp);
    }

    await expect(
      authenticator.authenticate({
        value: generateOrganizationApiKey(new Date()).raw,
        environment: 'production',
        clientIp,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(repository.findByHash).not.toHaveBeenCalled();
  });

  it('stores JWKS metadata for the stale-cache window and gates refreshes per organization', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
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

  it('uses process-local JWKS refresh admission without the integrity key', async () => {
    const redis = new FakeRedis();
    const store = createKeylessStore(redis);

    await expect(store.tryAcquireRefresh('org_acme')).resolves.toEqual({
      acquired: false,
      available: false,
    });
    expect(redis.values.has('aihub:v1:jwks-refresh:org_acme')).toBe(false);
  });

  it('uses the last-good JWKS locally when Redis is unavailable, bound to config version', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
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

  it('does not serve invalidated local JWKS after Redis becomes unavailable', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    await store.setJwks('org_local', '7', '0', {
      jwks: { keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB' }] },
      freshUntil: Date.now() + 1_000,
      staleUntil: Date.now() + 60_000,
    });
    redis.values.set('aihub:v1:jwks-generation:org_local', '1');

    await expect(store.getJwks('org_local', '7')).resolves.toEqual({
      generation: '1',
    });
    redis.failReads = true;

    await expect(store.getJwks('org_local', '7')).resolves.toEqual({
      generation: '0',
    });
  });

  it('confirms JWKS cache deletion for an Organization', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
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

  it('rejects a replayed JWKS after the durable config version advances', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    const organizationId = 'org_replay';
    const oldKey = 'aihub:v1:jwks:org_replay:1:0';
    const currentKey = 'aihub:v1:jwks:org_replay:2:0';
    const generationKey = 'aihub:v1:jwks-generation:org_replay';
    await store.setJwks(organizationId, '1', '0', {
      jwks: { keys: [{ kty: 'RSA', n: 'old-modulus', e: 'AQAB' }] },
      freshUntil: Date.now() + 1_000,
      staleUntil: Date.now() + 60_000,
    });
    const captured = redis.values.get(oldKey);
    if (captured === undefined) {
      throw new Error('JWKS cache entry was not written');
    }

    await store.deleteJwks(organizationId, '2');

    // Model a Redis writer restoring both the old generation and signed entry.
    redis.values.set(generationKey, '0');
    redis.values.set(oldKey, captured);
    redis.values.set(currentKey, captured);

    await expect(store.getJwks(organizationId, '2')).resolves.toEqual({
      generation: '0',
    });
    expect(redis.values.has(currentKey)).toBe(false);
  });

  it('falls back to Postgres and a local brute-force count when Redis is unavailable', async () => {
    const store = createStore(DEAD_REDIS);
    const failures = new RedisAuthFailureCounter('', DEAD_REDIS);

    await expect(store.get('a'.repeat(64))).resolves.toBeUndefined();
    await expect(store.deleteJwks('org_acme', '1')).rejects.toThrow(
      'redis down',
    );
    // A failed read no longer becomes zero: the address keeps its local count,
    // and the lookup budget is spent locally instead of failing open (#1511).
    await expect(failures.get('203.0.113.10')).resolves.toBe(0);
    await expect(failures.recordFailure('203.0.113.10')).resolves.toBe(1);
    await expect(failures.get('203.0.113.10')).resolves.toBe(1);
    await expect(failures.consumeUncachedLookup()).resolves.toEqual({
      allowed: true,
    });
  });
  it('bypasses unsigned Redis API-key entries when the integrity key is absent', async () => {
    const redis = new FakeRedis();
    const hash = '9'.repeat(64);
    const store = createKeylessStore(redis);
    redis.values.set(`aihub:v1:key:${hash}`, JSON.stringify(record));

    await expect(store.get(hash)).resolves.toBeUndefined();
    expect(redis.getCalls).toBe(0);
    expect(redis.values.has(`aihub:v1:key:${hash}`)).toBe(true);
  });

  it('invalidates JWKS when the integrity key is absent', async () => {
    const redis = new FakeRedis();
    const reader = createKeylessStore(redis);
    const hash = '8'.repeat(64);

    await reader.set(hash, record);
    await reader.setMiss('7'.repeat(64));
    await reader.setJwks('org_local', '1', '0', {
      jwks: { keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB' }] },
      freshUntil: Date.now() + 1_000,
      staleUntil: Date.now() + 60_000,
    });

    await expect(reader.get(hash)).resolves.toEqual(record);
    await expect(reader.getJwks('org_local', '1')).resolves.toMatchObject({
      generation: '0',
      entry: { jwks: { keys: [{ kty: 'RSA' }] } },
    });
    expect(redis.values.size).toBe(0);
    await reader.deleteJwks('org_local', '1');
    expect(redis.values.get('aihub:v1:jwks-generation:org_local')).toBe('1');
  });

  it('honors shared JWKS invalidation across keyless readers', async () => {
    const redis = new FakeRedis();
    const reader = createKeylessStore(redis);
    const otherReader = createKeylessStore(redis);
    const staleKey = 'aihub:v1:jwks:org_local:1:1';

    await reader.setJwks('org_local', '1', '0', {
      jwks: { keys: [{ kty: 'RSA', n: 'old-modulus', e: 'AQAB' }] },
      freshUntil: Date.now() + 1_000,
      staleUntil: Date.now() + 60_000,
    });
    redis.values.set(staleKey, JSON.stringify({ jwks: { keys: [] } }));

    await otherReader.deleteJwks('org_local', '1');

    await expect(reader.getJwks('org_local', '1')).resolves.toEqual({
      generation: '1',
    });
    expect(redis.values.get('aihub:v1:jwks-generation:org_local')).toBe('1');
    expect(redis.values.has(staleKey)).toBe(true);
  });

  it('rejects and deletes a forged positive API-key entry', async () => {
    const before = await integrityRejectionCount('api_key');
    const redis = new FakeRedis();
    const hash = '6'.repeat(64);
    const key = `aihub:v1:key:${hash}`;
    const store = createStore(redis);
    redis.values.set(
      key,
      JSON.stringify({
        ...record,
        organizationId: 'org_attacker',
        expiresAt: null,
      }),
    );

    await expect(store.get(hash)).resolves.toBeUndefined();

    expect(redis.values.has(key)).toBe(false);
    expect(await integrityRejectionCount('api_key')).toBe(before + 1);
    const sample = (await getMetrics())
      .split('\n')
      .find((line) =>
        line.startsWith('aihub_identity_cache_integrity_rejections_total{'),
      );
    expect(sample).toContain('cache_kind="api_key"');
    expect(sample).not.toContain('org_attacker');
    expect(sample).not.toContain(hash);
  });

  it('rejects and deletes envelopes whose payload cannot be canonicalized', async () => {
    const apiRejectionsBefore = await integrityRejectionCount('api_key');
    const jwksRejectionsBefore = await integrityRejectionCount('jwks');
    const apiUnavailableBefore = await redisUnavailableCount('api_key_cache');
    const jwksUnavailableBefore = await redisUnavailableCount('jwks_cache');
    const redis = new FakeRedis();
    const positiveHash = 'c'.repeat(64);
    const missHash = 'd'.repeat(64);
    const organizationId = 'org_malformed';
    const positiveKey = apiKeyCacheKey(positiveHash);
    const missKey = apiKeyCacheMissKey(missHash);
    const jwksKey = `aihub:v1:jwks:${organizationId}:1:0`;
    redis.values.set(
      positiveKey,
      JSON.stringify({ version: 1, kind: 'api_key', mac: 'invalid' }),
    );
    redis.values.set(
      missKey,
      JSON.stringify({ version: 1, kind: 'api_key', mac: 'invalid' }),
    );
    redis.values.set(
      jwksKey,
      JSON.stringify({ version: 1, kind: 'jwks', mac: 'invalid' }),
    );
    const store = createStore(redis);

    await expect(store.get(positiveHash)).resolves.toBeUndefined();
    await expect(store.get(missHash)).resolves.toBeUndefined();
    await expect(store.getJwks(organizationId, '1')).resolves.toEqual({
      generation: '0',
    });

    expect(redis.values.has(positiveKey)).toBe(false);
    expect(redis.values.has(missKey)).toBe(false);
    expect(redis.values.has(jwksKey)).toBe(false);
    expect(await integrityRejectionCount('api_key')).toBe(
      apiRejectionsBefore + 2,
    );
    expect(await integrityRejectionCount('jwks')).toBe(
      jwksRejectionsBefore + 1,
    );
    expect(await redisUnavailableCount('api_key_cache')).toBe(
      apiUnavailableBefore,
    );
    expect(await redisUnavailableCount('jwks_cache')).toBe(
      jwksUnavailableBefore,
    );
  });

  it('rejects a signed cache entry with a nested own __proto__ key', () => {
    const cacheKey = apiKeyCacheKey('e'.repeat(64));
    const data = JSON.parse(
      '{"nested":[{"__proto__":{"polluted":true}}]}',
    ) as unknown;
    const serialized = signIdentityCacheEntry(
      TEST_HMAC_KEY,
      'api_key',
      cacheKey,
      data,
    );

    expect(
      verifyIdentityCacheEntry({
        key: TEST_HMAC_KEY,
        kind: 'api_key',
        redisKey: cacheKey,
        serialized,
      }),
    ).toEqual({ authenticated: false });
  });

  it('rejects a tampered record inside a plausible authenticated envelope', async () => {
    const redis = new FakeRedis();
    const hash = '1'.repeat(64);
    const key = `aihub:v1:key:${hash}`;
    await createStore(redis).set(hash, record);
    const serialized = redis.values.get(key);
    if (serialized === undefined)
      throw new Error('expected a signed cache entry');
    redis.values.set(key, serialized.replace('org_acme', 'org_attacker'));

    await expect(createStore(redis).get(hash)).resolves.toBeUndefined();
    expect(redis.values.has(key)).toBe(false);
  });

  it('binds API-key signatures to the exact Redis key', async () => {
    const redis = new FakeRedis();
    const source = createStore(redis);
    const originalHash = '5'.repeat(64);
    const otherHash = '4'.repeat(64);
    await source.set(originalHash, record);
    const serialized = redis.values.get(`aihub:v1:key:${originalHash}`);
    if (serialized === undefined)
      throw new Error('expected a signed cache entry');
    redis.values.set(`aihub:v1:key:${otherHash}`, serialized);

    await expect(createStore(redis).get(otherHash)).resolves.toBeUndefined();
    expect(redis.values.has(`aihub:v1:key:${otherHash}`)).toBe(false);
  });

  it('keeps a signed entry within its original deadline when Redis TTL is extended or replayed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const redis = new FakeRedis();
    const hash = '3'.repeat(64);
    const key = `aihub:v1:key:${hash}`;
    await createStore(redis).set(hash, record);
    redis.expiresAt.set(key, Date.now() + 60_000);
    jest.advanceTimersByTime(30_001);

    await expect(createStore(redis).get(hash)).resolves.toBeUndefined();
    expect(redis.values.has(key)).toBe(false);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('lets Redis shorten a signed API-key entry but never extends its local lease', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const redis = new FakeRedis();
    const hash = '2'.repeat(64);
    const key = `aihub:v1:key:${hash}`;
    await createStore(redis).set(hash, record);
    redis.expiresAt.set(key, Date.now() + 100);
    const reader = createStore(redis);

    await expect(reader.get(hash)).resolves.toEqual(record);
    jest.advanceTimersByTime(101);
    await expect(reader.get(hash)).resolves.toBeUndefined();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('rejects a JWKS entry signed with another environment key', async () => {
    const before = await integrityRejectionCount('jwks');
    const redis = new FakeRedis();
    const attackerKey = Buffer.alloc(32, 9);
    const entry = {
      jwks: { keys: [{ kty: 'RSA', n: 'attacker', e: 'AQAB' }] },
      freshUntil: Date.now() + 1_000,
      staleUntil: Date.now() + 60_000,
    };
    await createStore(redis, attackerKey).setJwks('org_acme', '1', '0', entry);

    await expect(createStore(redis).getJwks('org_acme', '1')).resolves.toEqual({
      generation: '0',
    });

    expect(redis.values.has('aihub:v1:jwks:org_acme:1:0')).toBe(false);
    expect(await integrityRejectionCount('jwks')).toBe(before + 1);
  });

  it('binds JWKS entries to the JWKS cache kind', async () => {
    const redis = new FakeRedis();
    const cacheKey = 'aihub:v1:jwks:org_acme:1:0';
    const entry = {
      jwks: { keys: [{ kty: 'RSA', n: 'attacker', e: 'AQAB' }] },
      freshUntil: Date.now() + 1_000,
      staleUntil: Date.now() + 60_000,
    };
    redis.values.set(
      cacheKey,
      signIdentityCacheEntry(TEST_HMAC_KEY, 'api_key', cacheKey, entry),
    );
    redis.expiresAt.set(cacheKey, Date.now() + 60_000);

    await expect(createStore(redis).getJwks('org_acme', '1')).resolves.toEqual({
      generation: '0',
    });
    expect(redis.values.has(cacheKey)).toBe(false);
  });

  it('does not extend an authenticated JWKS stale deadline when Redis TTL is extended', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    const redis = new FakeRedis();
    const cacheKey = 'aihub:v1:jwks:org_acme:1:0';
    await createStore(redis).setJwks('org_acme', '1', '0', {
      jwks: { keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB' }] },
      freshUntil: Date.now() + 10_000,
      staleUntil: Date.now() + 30_000,
    });
    redis.expiresAt.set(cacheKey, Date.now() + 60_000);
    jest.advanceTimersByTime(30_001);

    await expect(createStore(redis).getJwks('org_acme', '1')).resolves.toEqual({
      generation: '0',
    });
    expect(redis.values.has(cacheKey)).toBe(false);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
});
