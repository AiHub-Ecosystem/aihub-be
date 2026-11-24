import { randomBytes } from 'node:crypto';

import type Redis from 'ioredis';

import { purgeApiKeyCache } from '@/cli/cli-redis';
import type { ApiKeyCacheInvalidationSeam } from '@/common/observability/metrics/redis-unavailable-metric';
import {
  type ApiKeyRecord,
  apiKeyCacheKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { RedisIdentityStore } from '@/modules/identity/shared/infrastructure/redis-identity.store';

import { createTenantIsolationRedis } from '../fixtures';

import {
  eventually,
  redisTarget,
  redisThroughProxy,
  redisUnavailableCount,
  rejection,
  timed,
} from './fault-targets';
import type { FaultMode, TcpFaultProxy } from './tcp-fault-proxy';

// The revoke, rotation, and suspension cache-invalidation rows of the #2019
// matrix. The durable change is already committed when the purge runs; these
// cases prove what a failed purge leaves behind and how it is closed.
const IDENTITY_CACHE_HMAC_KEY = Buffer.alloc(32, 0x5a);
// The positive-cache lifetime the matrix names as the stale ceiling.
const POSITIVE_TTL_MS = 60_000;
// The request-path client's command timeout is 500 ms.
const PURGE_BOUND_MS = 1_500;
// The operator CLI connects and runs commands with 5 s timeouts.
const CLI_PURGE_BOUND_MS = 6_500;

const RECORD: ApiKeyRecord = {
  organizationId: 'org_cache_invalidation',
  apiKeyId: 'ak_cache_invalidation',
  organizationStatus: 'active',
  status: 'active',
  scopes: ['writing.grade'],
  entitlements: ['writing'],
  allowedEnvironments: ['production'],
  expiresAt: null,
  rateLimitRpm: 600,
  maxConcurrent: 2,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
};

let proxy: TcpFaultProxy;
let proxiedUrl: string;
let raw: Redis;
// A peer process that cached the key, on a direct Redis connection.
let peer: RedisIdentityStore;
// The process that commits the change and purges, through the fault proxy.
let purger: RedisIdentityStore;

function keyHash(): string {
  return randomBytes(32).toString('hex');
}

async function cachedTtlMs(hash: string): Promise<number> {
  return raw.pttl(apiKeyCacheKey(hash));
}

/**
 * Caches the key on the peer, once both clients are connected: a write the
 * client cannot send yet is dropped silently, by design.
 */
async function cacheOnPeer(hash: string): Promise<void> {
  await eventually(async () => {
    await peer.set(hash, RECORD);
    await purger.delete(keyHash());
    return (await cachedTtlMs(hash)) > 0;
  });
}

beforeAll(async () => {
  const target = await redisThroughProxy();
  proxy = target.proxy;
  proxiedUrl = target.url;
  raw = createTenantIsolationRedis();
  const direct = redisTarget();
  peer = new RedisIdentityStore(
    `redis://${direct.host}:${direct.port}${direct.database}`,
    undefined,
    IDENTITY_CACHE_HMAC_KEY,
  );
  purger = new RedisIdentityStore(
    proxiedUrl,
    undefined,
    IDENTITY_CACHE_HMAC_KEY,
  );
});

afterEach(async () => {
  await proxy.setMode('normal');
});

afterAll(async () => {
  await peer.onModuleDestroy();
  await purger.onModuleDestroy();
  await proxy.close();
  await raw.quit();
});

describe.each<ApiKeyCacheInvalidationSeam>([
  'api_key_cache_invalidation_revoke',
  'api_key_cache_invalidation_rotate',
])('%s while Redis is down', (seam) => {
  it.each<FaultMode>(['refuse', 'hang'])(
    'never fails the committed change when Redis is %s, leaves at most the 60 s positive entry, and a repeat purge removes it',
    async (mode) => {
      const hash = keyHash();
      await cacheOnPeer(hash);
      const before = await redisUnavailableCount(seam);

      await proxy.setMode(mode);
      const failed = await timed(() => purger.delete(hash, seam));

      // The use cases await this purge; it resolves, so the revoke or
      // rotation still answers success.
      expect(failed.result.status).toBe('fulfilled');
      expect(failed.ms).toBeLessThan(PURGE_BOUND_MS);
      expect(await redisUnavailableCount(seam)).toBe(before + 1);
      // Another process can keep accepting the key from this entry, but only
      // for the rest of its positive lifetime.
      const stale = await cachedTtlMs(hash);
      expect(stale).toBeGreaterThan(0);
      expect(stale).toBeLessThanOrEqual(POSITIVE_TTL_MS);

      await proxy.setMode('normal');
      await eventually(async () => {
        await purger.delete(hash, seam);
        return (await cachedTtlMs(hash)) === -2;
      });
    },
  );
});

describe('organization suspension purge while Redis is down', () => {
  it.each<FaultMode>(['refuse', 'hang'])(
    'fails the operator purge inside its bound when Redis is %s, leaves at most the 60 s positive entry, and a repeat purges it',
    async (mode) => {
      const hash = keyHash();
      await cacheOnPeer(hash);

      await proxy.setMode(mode);
      const failed = await timed(() => purgeApiKeyCache(proxiedUrl, [hash]));

      // organization-status.ts catches this, records the suspension seam, and
      // still reports the committed suspension (organization-status.spec.ts).
      rejection(failed.result);
      expect(failed.ms).toBeLessThan(CLI_PURGE_BOUND_MS);
      const stale = await cachedTtlMs(hash);
      expect(stale).toBeGreaterThan(0);
      expect(stale).toBeLessThanOrEqual(POSITIVE_TTL_MS);

      await proxy.setMode('normal');
      await purgeApiKeyCache(proxiedUrl, [hash]);
      expect(await cachedTtlMs(hash)).toBe(-2);
    },
    15_000,
  );
});
