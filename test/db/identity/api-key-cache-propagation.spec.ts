import Redis from 'ioredis';

import { numberReply } from '@/common/redis/number-reply';
import { ApiKeyAuthenticator } from '@/modules/identity/api-keys/application/api-key-authenticator';
import {
  type ApiKeyRecord,
  type ApiKeyRepositoryPort,
  type AuthFailureCounterPort,
  apiKeyCacheKey,
  apiKeyCacheMissKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { hashApiKey } from '@/modules/identity/api-keys/application/organization-api-key-generator';
import { signIdentityCacheEntry } from '@/modules/identity/shared/infrastructure/identity-cache-envelope';
import type { RedisIdentityClient } from '@/modules/identity/shared/infrastructure/redis-identity-client';
import { RedisIdentityStore } from '@/modules/identity/shared/infrastructure/redis-identity.store';

import { openFlushedSandboxRedis } from '../shared/flushed-sandbox-redis';

const VALID_KEY = `aihub_sk_${'A'.repeat(43)}`;
const HMAC_KEY = Buffer.alloc(32, 75);
const ACTIVE_RECORD: ApiKeyRecord = {
  organizationId: 'org_cache_test',
  apiKeyId: 'ak_cache_test',
  organizationStatus: 'active',
  status: 'active',
  scopes: ['writing.grade'],
  entitlements: ['writing'],
  allowedEnvironments: ['production'],
  expiresAt: null,
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
};

let redis: Redis;
let readerRedis: Redis;

function clientFor(
  client: Redis,
  beforePttl?: (key: string) => Promise<void>,
  failDelete = false,
): RedisIdentityClient {
  return {
    get: (key) => client.get(key),
    pttl: async (key) => {
      await beforePttl?.(key);
      return client.pttl(key);
    },
    set: (key, value, mode, seconds, condition) =>
      condition === undefined
        ? client.set(key, value, mode, seconds)
        : client.set(key, value, mode, seconds, condition),
    del: (...keys) =>
      failDelete
        ? Promise.reject(new Error('Redis delete unavailable'))
        : client.del(...keys),
    incr: (key) => client.incr(key),
    eval: (script, numberOfKeys, ...args) =>
      client.eval(script, numberOfKeys, ...args).then(numberReply),
    expire: (key, seconds) => client.expire(key, seconds),
    quit: () => client.quit(),
  };
}

function controlledClock(start: number) {
  let wallTime = start;
  let monotonicTime = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => wallTime);
  jest.spyOn(performance, 'now').mockImplementation(() => monotonicTime);

  return {
    now: () => wallTime,
    advance: (milliseconds: number) => {
      wallTime += milliseconds;
      monotonicTime += milliseconds;
    },
  };
}

function failureCounter(): AuthFailureCounterPort {
  return {
    get: async () => 0,
    recordFailure: async () => 1,
    consumeSandboxKeyLookup: async () => true,
    consumeUncachedLookup: async () => ({ allowed: true }),
  };
}

class MutableRepository implements ApiKeyRepositoryPort {
  constructor(public record: ApiKeyRecord | null) {}

  async findByHash(): Promise<ApiKeyRecord | null> {
    return this.record;
  }

  async touchLastUsed(): Promise<void> {}
}

beforeAll(async () => {
  redis = await openFlushedSandboxRedis();
  readerRedis = redis.duplicate();
  await readerRedis.ping();
});

beforeEach(async () => {
  await redis.flushdb();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await readerRedis.quit();
  await redis.quit();
});

describe('API-key cache propagation across Redis-backed instances', () => {
  it('does not refill a purged key from a delayed pre-mutation lookup', async () => {
    const clock = controlledClock(Date.now());
    const hash = hashApiKey(VALID_KEY);
    const storeA = new RedisIdentityStore('', clientFor(redis), HMAC_KEY);
    const storeB = new RedisIdentityStore('', clientFor(readerRedis), HMAC_KEY);
    const repository = new MutableRepository(ACTIVE_RECORD);
    let releaseLookup: ((record: ApiKeyRecord | null) => void) | undefined;
    let signalLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    let holdLookup = true;
    repository.findByHash = async () => {
      const snapshot = repository.record;
      if (!holdLookup) return snapshot;
      holdLookup = false;
      signalLookupStarted?.();
      return new Promise((resolve) => {
        releaseLookup = resolve;
      }).then(() => snapshot);
    };
    const freshUntil = jest.spyOn(storeA, 'newPositiveFreshUntil');
    const authenticatorA = new ApiKeyAuthenticator(
      repository,
      storeA,
      failureCounter(),
    );
    const authentication = authenticatorA.authenticate({
      value: VALID_KEY,
      environment: 'production',
      clientIp: '198.51.100.10',
    });

    await lookupStarted;
    const originalDeadline = freshUntil.mock.results[0]?.value as number;
    repository.record = { ...ACTIVE_RECORD, status: 'revoked' };
    await storeB.delete(hash);
    clock.advance(originalDeadline - clock.now() + 1);
    releaseLookup?.(ACTIVE_RECORD);

    await expect(authentication).resolves.toMatchObject({
      organizationId: ACTIVE_RECORD.organizationId,
    });
    await expect(readerRedis.get(apiKeyCacheKey(hash))).resolves.toBeNull();

    const authenticatorB = new ApiKeyAuthenticator(
      repository,
      storeB,
      failureCounter(),
    );
    await expect(
      authenticatorB.authenticate({
        value: VALID_KEY,
        environment: 'production',
        clientIp: '198.51.100.11',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each([
    ['succeeds', false],
    ['fails', true],
  ] as const)(
    'keeps another process local copy only through its original deadline when purge %s',
    async (_label, failDelete) => {
      const clock = controlledClock(Date.now());
      const hash = hashApiKey(VALID_KEY);
      const deadline = clock.now() + 30_000;
      const storeA = new RedisIdentityStore(
        '',
        clientFor(redis, undefined, failDelete),
        HMAC_KEY,
      );
      const storeB = new RedisIdentityStore(
        '',
        clientFor(readerRedis),
        HMAC_KEY,
      );
      await storeA.set(hash, ACTIVE_RECORD, deadline);

      await expect(storeB.get(hash)).resolves.toEqual(ACTIVE_RECORD);
      await expect(storeA.delete(hash)).resolves.toBeUndefined();
      const sharedEntryAfterPurge = await readerRedis.get(apiKeyCacheKey(hash));
      expect(sharedEntryAfterPurge !== null).toBe(failDelete);
      await expect(storeB.get(hash)).resolves.toEqual(ACTIVE_RECORD);

      clock.advance(deadline - clock.now() + 1);
      await expect(storeB.get(hash)).resolves.toBeUndefined();
      expect(await readerRedis.get(apiKeyCacheKey(hash))).toBeNull();
    },
  );

  it.each(['record', 'legacy miss'] as const)(
    'caps %s hydration to the fetched envelope deadline when PTTL is replaced',
    async (kind) => {
      const clock = controlledClock(Date.now());
      const hash = hashApiKey(VALID_KEY);
      const key =
        kind === 'record' ? apiKeyCacheKey(hash) : apiKeyCacheMissKey(hash);
      const originalFreshUntil = clock.now() + 1_000;
      let replaced = false;
      const reader = clientFor(readerRedis, async (pttlKey) => {
        if (pttlKey !== key || replaced) return;
        replaced = true;
        if (kind === 'record') {
          const replacement = {
            ...ACTIVE_RECORD,
            status: 'revoked' as const,
          };
          await redis.set(
            key,
            signIdentityCacheEntry(HMAC_KEY, 'api_key', key, {
              type: 'record',
              freshUntil: clock.now() + 60_000,
              record: replacement,
            }),
            'EX',
            60,
          );
        } else {
          const positiveKey = apiKeyCacheKey(hash);
          await redis.set(
            key,
            signIdentityCacheEntry(HMAC_KEY, 'api_key', key, {
              type: 'miss',
              freshUntil: clock.now() + 60_000,
            }),
            'EX',
            60,
          );
          await redis.set(
            positiveKey,
            signIdentityCacheEntry(HMAC_KEY, 'api_key', positiveKey, {
              type: 'record',
              freshUntil: clock.now() + 60_000,
              record: ACTIVE_RECORD,
            }),
            'EX',
            60,
          );
        }
      });
      const store = new RedisIdentityStore('', reader, HMAC_KEY);

      const initialValue = kind === 'record' ? ACTIVE_RECORD : null;
      if (kind === 'record') {
        await redis.set(
          key,
          signIdentityCacheEntry(HMAC_KEY, 'api_key', key, {
            type: 'record',
            freshUntil: originalFreshUntil,
            record: ACTIVE_RECORD,
          }),
          'EX',
          60,
        );
      } else {
        await redis.set(
          key,
          signIdentityCacheEntry(HMAC_KEY, 'api_key', key, {
            type: 'miss',
            freshUntil: originalFreshUntil,
          }),
          'EX',
          60,
        );
      }
      await expect(store.get(hash)).resolves.toEqual(initialValue);

      clock.advance(1_001);
      await expect(store.get(hash)).resolves.toEqual(
        kind === 'record'
          ? { ...ACTIVE_RECORD, status: 'revoked' }
          : ACTIVE_RECORD,
      );
    },
  );
});
