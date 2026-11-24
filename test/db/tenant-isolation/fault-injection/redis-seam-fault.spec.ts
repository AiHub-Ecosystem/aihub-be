import { randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

import {
  REDIS_NO_REPLAY_OPTIONS,
  createRedisClient,
} from '@/common/redis/create-redis-client';
import { RedisEmailSendRateLimiter } from '@/modules/auth/email-delivery/infrastructure/redis-rate-limiter/redis-email-send-rate-limiter';
import { RedisDpopReplayCache } from '@/modules/auth/web-sessions/infrastructure/redis-dpop-replay-cache';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from '@/modules/gateway/infrastructure/redis-gateway.client';
import {
  SHEDDING_LEVEL_KEY,
  SheddingLevelStore,
} from '@/modules/gateway/infrastructure/shedding-level.store';

import { createTenantIsolationRedis } from '../fixtures';

import {
  eventually,
  redisAnswers,
  redisThroughProxy,
  redisUnavailableCount,
  rejection,
  timed,
} from './fault-targets';
import type { FaultMode, TcpFaultProxy } from './tcp-fault-proxy';

// Redis seams of the #2019 matrix whose fallback is decided in the adapter:
// DPoP replay markers, the shared shedding level, and the email send rate.
// Each adapter's command timeout is 500 ms; a refusal or timeout must come
// back well inside a second.
const FAILURE_BOUND_MS = 1_500;
// How long a peer's shedding level is trusted after its last read.
const SHARED_LEVEL_TRUST_MS = 15_000;
// The limiter's deferral when Redis cannot answer (RETRY_WHEN_UNAVAILABLE_MS).
const EMAIL_RETRY_WHEN_UNAVAILABLE_MS = 5_000;
const NOOP_LOGGER = { warn: () => undefined, log: () => undefined };

let proxy: TcpFaultProxy;
let proxiedUrl: string;
let dpopRedis: Redis;
let dpop: RedisDpopReplayCache;
let gatewayRedis: RedisGatewayClient;
let email: RedisEmailSendRateLimiter;

function replayKey(): { issuer: string; jkt: string; jti: string } {
  return { issuer: 'https://issuer.test', jkt: 'jkt', jti: randomUUID() };
}

beforeAll(async () => {
  const target = await redisThroughProxy();
  proxy = target.proxy;
  proxiedUrl = target.url;
  // Built as auth-runtime.module.ts and gateway.module.ts build them.
  dpopRedis = createRedisClient(proxiedUrl, {
    commandTimeoutMs: 500,
    ...REDIS_NO_REPLAY_OPTIONS,
  });
  dpopRedis.on('error', () => undefined);
  dpop = new RedisDpopReplayCache(dpopRedis);
  const gateway = createRedisGatewayClient(proxiedUrl);
  if (gateway === undefined) throw new Error('Gateway Redis client missing');
  gatewayRedis = gateway;
  await redisAnswers(gatewayRedis);
  email = new RedisEmailSendRateLimiter(proxiedUrl, 1_000, 1_000);
});

afterEach(async () => {
  await proxy.setMode('normal');
});

afterAll(async () => {
  // Close every client first, so a failed cleanup step cannot leave a handle
  // that keeps Jest from exiting.
  await dpop.onModuleDestroy();
  await gatewayRedis.quit().catch(() => undefined);
  email.onModuleDestroy();
  await proxy.close();
  // A published level would shed gradings in later specs of this lane. The
  // proxied clients may still be reconnecting after the last fault, so the
  // key is removed on a direct connection.
  const raw = createTenantIsolationRedis();
  try {
    // The client has no offline queue, so wait until it is connected.
    await redisAnswers(raw);
    await raw.del(SHEDDING_LEVEL_KEY);
  } finally {
    await raw.quit();
  }
});

describe('DPoP replay marker while Redis is down', () => {
  it.each<FaultMode>(['refuse', 'hang'])(
    'rejects a claim inside the bound when Redis is %s and counts the seam',
    async (mode) => {
      await eventually(async () => dpop.claim(replayKey(), 60));
      const before = await redisUnavailableCount('dpop_replay');

      await proxy.setMode(mode);
      const call = await timed(() => dpop.claim(replayKey(), 60));

      // The guard turns this rejection into 503 REDIS_UNAVAILABLE
      // (user-access-jwt.guard.dpop.spec.ts); a claim never resolves true.
      rejection(call.result);
      expect(call.ms).toBeLessThan(FAILURE_BOUND_MS);
      expect(await redisUnavailableCount('dpop_replay')).toBe(before + 1);
    },
  );

  it('detects a replay again once Redis returns', async () => {
    await proxy.setMode('refuse');
    await proxy.setMode('normal');
    const key = replayKey();

    await eventually(async () => dpop.claim(key, 60));
    await expect(dpop.claim(key, 60)).resolves.toBe(false);
  });
});

describe('shared shedding level while Redis is down', () => {
  it('trusts a peer level for at most 15 s, keeps the local level, and never sheds for Redis alone', async () => {
    let now = Date.now();
    const clock = (): number => now;
    const publisher = new SheddingLevelStore(gatewayRedis, NOOP_LOGGER, clock);
    const peer = new SheddingLevelStore(gatewayRedis, NOOP_LOGGER, clock);
    await publisher.setLocal(2);
    await peer.refresh();
    expect(peer.current()).toBe(2);
    const before = await redisUnavailableCount('shedding_level');

    await proxy.setMode('refuse');
    const failedRead = await timed(() => peer.refresh());
    const failedPublish = await timed(() => peer.setLocal(1));

    // Neither the read nor the publish throws onto the request path.
    expect(failedRead.result.status).toBe('fulfilled');
    expect(failedPublish.result.status).toBe('fulfilled');
    expect(failedRead.ms).toBeLessThan(FAILURE_BOUND_MS);
    expect(failedPublish.ms).toBeLessThan(FAILURE_BOUND_MS);
    expect(await redisUnavailableCount('shedding_level')).toBeGreaterThan(
      before,
    );
    // The last good peer read still counts inside its trust window.
    now += SHARED_LEVEL_TRUST_MS - 1_000;
    expect(peer.current()).toBe(2);
    // Past it, only the instance's own governor level applies.
    now += 2_000;
    expect(peer.current()).toBe(1);
    await peer.setLocal(0);
    expect(peer.current()).toBe(0);
  });
});

describe('email send rate while Redis is down', () => {
  it.each<FaultMode>(['refuse', 'hang'])(
    'defers a send inside the bound when Redis is %s instead of bypassing the shared limit',
    async (mode) => {
      await eventually(async () => (await email.reserve()).reserved);
      const before = await redisUnavailableCount('email_send_rate');

      await proxy.setMode(mode);
      const call = await timed(() => email.reserve());

      expect(call.result).toEqual({
        status: 'fulfilled',
        value: {
          reserved: false,
          retryAfterMs: EMAIL_RETRY_WHEN_UNAVAILABLE_MS,
        },
      });
      expect(call.ms).toBeLessThan(FAILURE_BOUND_MS);
      expect(await redisUnavailableCount('email_send_rate')).toBe(before + 1);
    },
  );

  it('reserves sends again once Redis returns', async () => {
    await proxy.setMode('refuse');
    await expect(email.reserve()).resolves.toMatchObject({ reserved: false });

    await proxy.setMode('normal');
    await eventually(async () => (await email.reserve()).reserved);
  });
});
